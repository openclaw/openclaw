import { asOptionalObjectRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type {
  ApplicationContext,
  ApplicationGateway,
  ApplicationGatewaySnapshot,
} from "../../../app/context.ts";
import {
  showConfirmDialog,
  type ConfirmDialogOptions,
} from "../../../components/confirm-dialog.ts";
import { t } from "../../../i18n/index.ts";
import { registerDreamingEnglish } from "../../../i18n/locales/en-dreaming.ts";
import { currentConfigObject } from "../../../lib/config/config-state-model.ts";
import { formatTimeMs } from "../../../lib/format.ts";
import { isPluginEnabledInConfigSnapshot } from "../../../lib/plugin-activation.ts";
import { GatewayPageController } from "../../../lit/gateway-page-controller.ts";
import {
  ControllerHost,
  SubscriptionsController,
  viewState,
} from "../../../lit/subscriptions-controller.ts";
import {
  canCallDreamingMethod,
  copyDreamingArchivePath,
  createDreamingState,
  loadDreamingResource,
  resolveConfiguredDreaming,
  runDreamDiaryAction,
  updateDreamingEnabled,
  type DreamDiaryActionMethod,
  type DreamingResourceKey,
  type DreamingState,
  type WikiPagePreview,
} from "./dreaming.ts";
import type { DreamingToggleConfirmationProps } from "./toggle-confirmation.tsx";
import { createDreamingViewState, type DreamingProps, type DreamingViewState } from "./view.tsx";

registerDreamingEnglish();

type DreamingTaskScope = {
  gateway: ApplicationGateway;
  epoch: number;
  state: DreamingState;
};

function resolveDreamingNextCycle(status: DreamingState["dreamingStatus"]): string | null {
  const nextRunAtMs = Object.values(status?.phases ?? {})
    .flatMap((phase) =>
      phase.enabled && typeof phase.nextRunAtMs === "number" ? [phase.nextRunAtMs] : [],
    )
    .toSorted((a, b) => a - b)[0];
  return formatTimeMs(nextRunAtMs, { hour: "numeric", minute: "2-digit" }, "") || null;
}

/**
 * Whether the memory slot owner reports its own dreaming. Any report counts —
 * a provider may omit `enabled` and report only phases or counters — so the
 * host switch is locked on presence, not on the optional enablement flag.
 */
function ownerReportsDreaming(status: DreamingState["dreamingStatus"] | null): boolean {
  return status?.reportedByProvider === true || typeof status?.reportedEnabled === "boolean";
}

export class AgentMemoryState extends ControllerHost {
  context!: ApplicationContext;

  private selectedId = "";
  get agentId() {
    return this.selectedId;
  }
  set agentId(value: string) {
    this.selectedId = value;
    if (this.isConnected) {
      this.applyAgentId();
    }
    this.requestUpdate();
  }

  @viewState() private dreaming = createDreamingState();
  @viewState() private toggleConfirmLoading = false;
  @viewState() private pendingEnabled: boolean | null = null;

  private readonly viewState: DreamingViewState = createDreamingViewState();
  private readonly gateway = new GatewayPageController(this, {
    getGateway: () => this.context?.gateway,
    onSnapshot: ({ snapshot, initial, sourceChanged }) =>
      this.applyGatewaySnapshot(
        snapshot,
        initial ? "initial" : sourceChanged ? "replacement" : undefined,
      ),
  });
  private selectedAgentId: string | null = null;
  private readonly subscriptions = new SubscriptionsController(this).effect(
    () => this.context?.runtimeConfig,
    (runtimeConfig) => {
      this.syncConfigSnapshot();
      return runtimeConfig.subscribe(() => {
        this.syncConfigSnapshot();
        this.requestUpdate();
      });
    },
  );

  override connect() {
    super.connect();
    this.applyAgentId();
  }

  override disconnect() {
    this.subscriptions.clear();
    this.resetTransientState();
    this.dreaming = createDreamingState();
    super.disconnect();
  }

  private captureTaskScope(): DreamingTaskScope | null {
    const gateway = this.gateway.gateway;
    if (!gateway) {
      return null;
    }
    return { gateway, epoch: this.gateway.epoch, state: this.dreaming };
  }

  private isTaskScopeCurrent(scope: DreamingTaskScope): boolean {
    return (
      this.isConnected &&
      this.gateway.gateway === scope.gateway &&
      this.gateway.epoch === scope.epoch &&
      this.context.gateway === scope.gateway &&
      this.dreaming === scope.state
    );
  }

  private resetTransientState() {
    this.viewState.wikiPreview = null;
    this.toggleConfirmLoading = false;
    this.pendingEnabled = null;
  }

  private createGatewayState(snapshot = this.context.gateway.snapshot): DreamingState {
    return createDreamingState({
      client: snapshot.client,
      connected: snapshot.phase === "connected",
      hello: snapshot.hello,
      configSnapshot: this.context.runtimeConfig.state.configSnapshot,
      selectedAgentId: this.selectedAgentId,
    });
  }

  private applyGatewaySnapshot(
    snapshot: ApplicationGatewaySnapshot,
    sourceBind?: "initial" | "replacement",
  ) {
    const clientChanged = this.dreaming.client !== snapshot.client;
    const connectionChanged = this.dreaming.connected !== (snapshot.phase === "connected");
    const replaceState = sourceBind === "replacement" || clientChanged || connectionChanged;
    if (replaceState) {
      this.dreaming = this.createGatewayState(snapshot);
      if (sourceBind !== "initial") {
        this.resetTransientState();
      }
    } else {
      this.dreaming.connected = snapshot.phase === "connected";
      this.dreaming.hello = snapshot.hello;
    }
    if (snapshot.phase === "connected" && this.selectedAgentId && replaceState) {
      void this.loadResources();
    }
    this.requestUpdate();
  }

  private applyAgentId() {
    const agentId = this.agentId.trim() || null;
    if (this.selectedAgentId === agentId) {
      return;
    }
    this.selectedAgentId = agentId;
    this.gateway.invalidate();
    this.resetTransientState();
    this.dreaming = this.createGatewayState();
    if (agentId && this.dreaming.connected) {
      void this.loadResources();
    }
  }

  private syncConfigSnapshot() {
    this.dreaming.configSnapshot = this.context.runtimeConfig.state.configSnapshot;
  }

  private async runDreamingTask<T>(
    task: (state: DreamingState) => Promise<T>,
    scope = this.captureTaskScope(),
  ): Promise<T | undefined> {
    if (!scope || !this.isTaskScopeCurrent(scope)) {
      return undefined;
    }
    const result = task(scope.state);
    this.requestUpdate();
    try {
      const value = await result;
      return this.isTaskScopeCurrent(scope) ? value : undefined;
    } finally {
      if (this.isTaskScopeCurrent(scope)) {
        this.requestUpdate();
      }
    }
  }

  private async confirmDreamingTask(
    method: DreamDiaryActionMethod,
    confirmation: ConfirmDialogOptions,
  ) {
    const scope = this.captureTaskScope();
    if (!scope || !(await showConfirmDialog(confirmation)) || !this.isTaskScopeCurrent(scope)) {
      return;
    }
    await this.runDreamingTask((current) => runDreamDiaryAction(current, method), scope);
  }

  private runDiaryAction(method: DreamDiaryActionMethod) {
    return this.runDreamingTask((current) => runDreamDiaryAction(current, method));
  }

  async loadResources(
    resource: DreamingResourceKey | "all" = "all",
    refreshConfig = resource !== "all",
  ) {
    const scope = this.captureTaskScope();
    if (
      !scope?.state.selectedAgentId ||
      (resource === "all" && (!scope.state.client || !scope.state.connected))
    ) {
      return;
    }
    const runtimeConfig = this.context.runtimeConfig;
    await (refreshConfig ? runtimeConfig.refresh() : runtimeConfig.ensureLoaded());
    if (!this.isTaskScopeCurrent(scope) || this.context.runtimeConfig !== runtimeConfig) {
      return;
    }
    this.syncConfigSnapshot();
    if (resource === "all") {
      await Promise.all(
        (["dreamingStatus", "dreamDiary", "wikiImportInsights", "wikiOverview"] as const).map(
          (key) => this.runDreamingTask((current) => loadDreamingResource(current, key), scope),
        ),
      );
    } else {
      await this.runDreamingTask((current) => loadDreamingResource(current, resource), scope);
    }
  }

  setEnabled(enabled: boolean) {
    if (
      this.ownerBlocks(enabled) ||
      !canCallDreamingMethod(this.dreaming, "config.patch", "operator.admin") ||
      this.dreaming.dreamingModeSaving ||
      this.toggleConfirmLoading ||
      this.pendingEnabled !== null
    ) {
      return;
    }
    this.pendingEnabled = enabled;
    this.dreaming.dreamingStatusError = null;
  }

  cancelToggle() {
    if (this.toggleConfirmLoading) {
      return;
    }
    this.pendingEnabled = null;
    this.dreaming.dreamingStatusError = null;
  }

  /** A slot owner that reports its own dreaming controls it. */
  private ownerRunsDreaming(): boolean {
    return ownerReportsDreaming(this.dreaming.dreamingStatus);
  }

  /**
   * Turning the host sweep on beside such an owner would dream twice, so that
   * direction is locked. Turning it off stays possible: an installation that
   * adopts a reporting owner while the host sweep is on needs a way to stop it.
   */
  private ownerBlocks(enabled: boolean | null): boolean {
    return enabled === true && this.ownerRunsDreaming();
  }

  async confirmToggle() {
    // The owner's report can arrive while the confirmation is already open.
    if (this.ownerBlocks(this.pendingEnabled)) {
      this.pendingEnabled = null;
      return;
    }
    const enabled = this.pendingEnabled;
    if (
      enabled == null ||
      this.toggleConfirmLoading ||
      !canCallDreamingMethod(this.dreaming, "config.patch", "operator.admin")
    ) {
      return;
    }
    this.toggleConfirmLoading = true;
    this.dreaming.dreamingStatusError = null;
    const scope = this.captureTaskScope();
    const runtimeConfig = this.context.runtimeConfig;
    if (!scope) {
      this.toggleConfirmLoading = false;
      return;
    }
    try {
      // Rechecked before each write step: the owner's report can also land
      // while the write awaits the schema lookup.
      const canDispatch = () =>
        this.isTaskScopeCurrent(scope) &&
        this.context.runtimeConfig === runtimeConfig &&
        !this.ownerBlocks(enabled) &&
        canCallDreamingMethod(scope.state, "config.patch", "operator.admin");
      const updated = await this.runDreamingTask(
        (dreamingState) =>
          updateDreamingEnabled(dreamingState, runtimeConfig, enabled, canDispatch),
        scope,
      );
      if (!this.isTaskScopeCurrent(scope) || this.context.runtimeConfig !== runtimeConfig) {
        return;
      }
      if (!updated) {
        // Declined by the owner lock, not failed: close like the early guard
        // does, and drop the failure a declined queued patch leaves behind.
        if (this.ownerBlocks(enabled)) {
          this.pendingEnabled = null;
          this.dreaming.dreamingStatusError = null;
          return;
        }
        this.dreaming.dreamingStatusError ??= t("dreaming.toggleConfirmation.failed");
        return;
      }
      await runtimeConfig.refresh();
      if (!this.isTaskScopeCurrent(scope) || this.context.runtimeConfig !== runtimeConfig) {
        return;
      }
      this.syncConfigSnapshot();
      await this.runDreamingTask(
        (current) => loadDreamingResource(current, "dreamingStatus"),
        scope,
      );
      if (!this.isTaskScopeCurrent(scope)) {
        return;
      }
      this.pendingEnabled = null;
    } finally {
      if (this.isTaskScopeCurrent(scope)) {
        this.toggleConfirmLoading = false;
      }
    }
  }

  private async openWikiPage(lookup: string): Promise<WikiPagePreview | null> {
    const scope = this.captureTaskScope();
    const client = scope?.state.client;
    const agentId = scope?.state.selectedAgentId;
    if (!scope || !client || !scope.state.connected || !agentId) {
      return null;
    }
    const response = await client.request("wiki.get", {
      lookup,
      fromLine: 1,
      lineCount: 5000,
      agentId,
    });
    if (!this.isTaskScopeCurrent(scope) || scope.state.selectedAgentId !== agentId) {
      return null;
    }
    const payload = asOptionalObjectRecord(response);
    const content =
      typeof payload?.content === "string" && payload.content.length > 0
        ? payload.content
        : t("dreaming.wiki.noContent");
    const updatedAt = normalizeOptionalString(payload?.updatedAt);
    const totalLines =
      typeof payload?.totalLines === "number" && Number.isFinite(payload.totalLines)
        ? Math.max(0, Math.floor(payload.totalLines))
        : undefined;
    return {
      title: normalizeOptionalString(payload?.title) ?? lookup,
      path: normalizeOptionalString(payload?.path) ?? lookup,
      content,
      ...(totalLines === undefined ? {} : { totalLines }),
      ...(payload?.truncated === true ? { truncated: true } : {}),
      ...(updatedAt ? { updatedAt } : {}),
    };
  }

  get view() {
    const dreaming = this.dreaming;
    const configState = this.context.runtimeConfig.state;
    const configuredDreaming = resolveConfiguredDreaming(currentConfigObject(configState));
    // The status RPC can complete after config switches the engine Off. Keep the
    // cached payload for a future refresh, but never present it as current runtime state.
    const dreamingStatus = configuredDreaming.engineOff ? null : dreaming.dreamingStatus;
    const dreamingOn = dreamingStatus?.enabled ?? configuredDreaming.enabled;
    // The toggle stays bound to the configuration it writes; a slot owner that
    // dreams on its own only lights the scene.
    // While a slot owner reports, the scene lights when the owner says it runs
    // or when a phase actually runs — the same per-phase truth the Settings
    // schedule and the next-sweep time below are built from. A counters-only
    // report or one with every phase disabled reads as idle, and an owner that
    // reports `enabled: false` cannot hide a host phase that is still scheduled
    // and would show its next run beside "Idle".
    const phaseRunning = Object.values(dreamingStatus?.phases ?? {}).some(
      (phase) => phase.enabled && phase.managedCronPresent,
    );
    const dreamingActive =
      dreamingStatus?.reportedByProvider === true
        ? dreamingStatus.reportedEnabled === true || phaseRunning
        : dreamingOn;
    // A slot owner that reports its own dreaming runs it itself. The toggle
    // writes the host setting, which such an owner does not follow and which
    // starts memory-core's own sweep beside it, so turning it on is locked.
    // Turning an already running host sweep off stays possible.
    const ownerDreams = ownerReportsDreaming(dreamingStatus);
    const ownerLocksToggle = ownerDreams && !dreamingOn;
    const ownerDreamsHint = ownerDreams
      ? t(dreamingOn ? "dreaming.header.ownerManagedHostOn" : "dreaming.header.ownerManaged", {
          plugin: configuredDreaming.pluginId,
        })
      : undefined;
    const loading = dreaming.dreamingStatusLoading || dreaming.dreamingModeSaving;
    const canUpdateConfig = canCallDreamingMethod(dreaming, "config.patch", "operator.admin");
    const canRunAction = (method: DreamDiaryActionMethod) =>
      canCallDreamingMethod(dreaming, method, "operator.write");
    const refreshLoading = dreaming.dreamingStatusLoading || dreaming.dreamDiaryLoading;
    const selectedAgentId = dreaming.selectedAgentId ?? "";

    return {
      header: {
        configuredDreaming,
        dreamingOn,
        loading,
        canUpdateConfig,
        refreshLoading,
        ownerLocksToggle,
        ownerDreamsHint,
      },
      dreaming: {
        access: {
          canOpenConfig: canCallDreamingMethod(dreaming, "config.openFile", "operator.admin", {
            requireAdvertisement: false,
          }),
          canBackfillDiary: canRunAction("doctor.memory.backfillDreamDiary"),
          canDedupeDreamDiary: canRunAction("doctor.memory.dedupeDreamDiary"),
          canResetDiary: canRunAction("doctor.memory.resetDreamDiary"),
          canResetGroundedShortTerm: canRunAction("doctor.memory.resetGroundedShortTerm"),
          canRepairDreamingArtifacts: canRunAction("doctor.memory.repairDreamingArtifacts"),
        },
        viewState: this.viewState,
        active: dreamingActive,
        selectedAgentId,
        shortTermCount: dreamingStatus?.shortTermCount ?? 0,
        promotedCount: dreamingStatus?.promotedToday ?? 0,
        scenePromotedCount: ownerDreams
          ? (dreamingStatus?.reportedStats?.promotedToday ?? null)
          : (dreamingStatus?.promotedToday ?? 0),
        ownerPluginId: ownerDreams ? configuredDreaming.pluginId : undefined,
        phases: dreamingStatus?.phases ?? undefined,
        shortTermEntries: dreamingStatus?.shortTermEntries ?? [],
        promotedEntries: dreamingStatus?.promotedEntries ?? [],
        nextCycle: resolveDreamingNextCycle(dreamingStatus),
        timezone: dreamingStatus?.timezone ?? null,
        statusError: dreaming.dreamingStatusError,
        modeSaving: dreaming.dreamingModeSaving,
        dreamDiaryLoading: dreaming.dreamDiaryLoading,
        dreamDiaryActionLoading: dreaming.dreamDiaryActionLoading,
        dreamDiaryActionMessage: dreaming.dreamDiaryActionMessage,
        dreamDiaryActionArchivePath: dreaming.dreamDiaryActionArchivePath,
        dreamDiaryError: dreaming.dreamDiaryError,
        dreamDiaryContent: dreaming.dreamDiaryContent,
        memoryWikiEnabled: isPluginEnabledInConfigSnapshot(
          configState.configSnapshot,
          "memory-wiki",
          { enabledByDefault: false },
        ),
        wikiImportInsightsLoading: dreaming.wikiImportInsightsLoading,
        wikiImportInsightsError: dreaming.wikiImportInsightsError,
        wikiImportInsights: dreaming.wikiImportInsights,
        wikiOverviewLoading: dreaming.wikiOverviewLoading,
        wikiOverviewError: dreaming.wikiOverviewError,
        wikiOverview: dreaming.wikiOverview,
        onRefreshDiary: () =>
          void this.runDreamingTask((current) => loadDreamingResource(current, "dreamDiary")),
        onRefreshImports: () => void this.loadResources("wikiImportInsights"),
        onRefreshWikiOverview: () => void this.loadResources("wikiOverview"),
        onOpenConfig: () => void this.context.runtimeConfig.openFile(),
        onOpenWikiPage: (lookup) => this.openWikiPage(lookup),
        onBackfillDiary: () => void this.runDiaryAction("doctor.memory.backfillDreamDiary"),
        onCopyDreamingArchivePath: () => void this.runDreamingTask(copyDreamingArchivePath),
        onDedupeDreamDiary: () =>
          void this.confirmDreamingTask("doctor.memory.dedupeDreamDiary", {
            title: t("dreaming.scene.dedupeDiary"),
            message: t("dreaming.actions.confirmDedupeDescription"),
            confirmLabel: t("dreaming.scene.dedupeDiary"),
            danger: true,
          }),
        onResetDiary: () => void this.runDiaryAction("doctor.memory.resetDreamDiary"),
        onResetGroundedShortTerm: () =>
          void this.runDiaryAction("doctor.memory.resetGroundedShortTerm"),
        onRepairDreamingArtifacts: () =>
          void this.confirmDreamingTask("doctor.memory.repairDreamingArtifacts", {
            title: t("dreaming.scene.repairCache"),
            message: t("dreaming.actions.confirmRepairDescription"),
            confirmLabel: t("dreaming.scene.repairCache"),
          }),
        onViewStateChange: () => this.requestUpdate(),
      } satisfies DreamingProps,
      toggle: {
        open: this.pendingEnabled !== null,
        enabling: this.pendingEnabled === true,
        ownerPluginId: ownerDreams ? configuredDreaming.pluginId : undefined,
        loading: this.toggleConfirmLoading,
        onConfirm: () => void this.confirmToggle(),
        onCancel: () => this.cancelToggle(),
        hasError: Boolean(dreaming.dreamingStatusError),
      } satisfies DreamingToggleConfirmationProps,
    };
  }
}
