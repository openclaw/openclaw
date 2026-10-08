import { consume } from "@lit/context";
import { asOptionalObjectRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { html, type PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import {
  applicationContext,
  type ApplicationContext,
  type ApplicationGateway,
  type ApplicationGatewaySnapshot,
} from "../../../app/context.ts";
import { shellLayoutTraits } from "../../../app/shell-layout-traits.ts";
import {
  showConfirmDialog,
  type ConfirmDialogOptions,
} from "../../../components/confirm-dialog.ts";
import { renderSettingsDefaultDescription } from "../../../components/settings-ui.ts";
import { t } from "../../../i18n/index.ts";
import { registerDreamingEnglish } from "../../../i18n/locales/en-dreaming.ts";
import { currentConfigObject } from "../../../lib/config/config-state-model.ts";
import { formatTimeMs } from "../../../lib/format.ts";
import { isPluginEnabledInConfigSnapshot } from "../../../lib/plugin-activation.ts";
import { GatewayPageController } from "../../../lit/gateway-page-controller.ts";
import { OpenClawLightDomElement } from "../../../lit/openclaw-element.ts";
import { SubscriptionsController } from "../../../lit/subscriptions-controller.ts";
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
import { renderDreamingToggleConfirmation } from "./toggle-confirmation.ts";
import { createDreamingViewState, renderDreaming, type DreamingViewState } from "./view.ts";

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

class AgentMemoryPanel extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: true })
  private context!: ApplicationContext;

  @property({ attribute: false }) agentId = "";

  @state() private dreaming = createDreamingState();
  @state() private toggleConfirmLoading = false;
  @state() private pendingEnabled: boolean | null = null;

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

  override updated(changed: PropertyValues<this>) {
    if (changed.has("agentId")) {
      this.applyAgentId();
    }
  }

  override disconnectedCallback() {
    this.subscriptions.clear();
    this.resetTransientState();
    this.dreaming = createDreamingState();
    super.disconnectedCallback();
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
      void this.loadAll();
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
      void this.loadAll();
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

  private async loadAll(refreshConfig = false) {
    const scope = this.captureTaskScope();
    if (!scope || !scope.state.client || !scope.state.connected || !scope.state.selectedAgentId) {
      return;
    }
    const runtimeConfig = this.context.runtimeConfig;
    await (refreshConfig ? runtimeConfig.refresh() : runtimeConfig.ensureLoaded());
    if (!this.isTaskScopeCurrent(scope) || this.context.runtimeConfig !== runtimeConfig) {
      return;
    }
    this.syncConfigSnapshot();
    await Promise.all(
      (["dreamingStatus", "dreamDiary", "wikiImportInsights", "wikiOverview"] as const).map((key) =>
        this.runDreamingTask((current) => loadDreamingResource(current, key), scope),
      ),
    );
  }

  private setEnabled(enabled: boolean) {
    if (
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

  private cancelToggle() {
    if (this.toggleConfirmLoading) {
      return;
    }
    this.pendingEnabled = null;
    this.dreaming.dreamingStatusError = null;
  }

  private async confirmToggle() {
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
      const canDispatch = () =>
        this.isTaskScopeCurrent(scope) &&
        this.context.runtimeConfig === runtimeConfig &&
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

  private async refreshWikiData(key: DreamingResourceKey) {
    const scope = this.captureTaskScope();
    if (!scope?.state.selectedAgentId) {
      return;
    }
    const runtimeConfig = this.context.runtimeConfig;
    await runtimeConfig.refresh();
    if (!this.isTaskScopeCurrent(scope) || this.context.runtimeConfig !== runtimeConfig) {
      return;
    }
    this.syncConfigSnapshot();
    await this.runDreamingTask((current) => loadDreamingResource(current, key), scope);
  }

  override render() {
    const dreaming = this.dreaming;
    const configState = this.context.runtimeConfig.state;
    const configuredDreaming = resolveConfiguredDreaming(currentConfigObject(configState));
    // The status RPC can complete after config switches the engine Off. Keep the
    // cached payload for a future refresh, but never present it as current runtime state.
    const dreamingStatus = configuredDreaming.engineOff ? null : dreaming.dreamingStatus;
    const dreamingOn = dreamingStatus?.enabled ?? configuredDreaming.enabled;
    const loading = dreaming.dreamingStatusLoading || dreaming.dreamingModeSaving;
    const canUpdateConfig = canCallDreamingMethod(dreaming, "config.patch", "operator.admin");
    const canRunAction = (method: DreamDiaryActionMethod) =>
      canCallDreamingMethod(dreaming, method, "operator.write");
    const refreshLoading = dreaming.dreamingStatusLoading || dreaming.dreamDiaryLoading;
    const selectedAgentId = dreaming.selectedAgentId ?? "";

    return html`
      <section
        class="content-header content-header--page agent-memory-panel__header"
        ${shellLayoutTraits({ toolbarHeader: true })}
      >
        <div class="page-meta">
          <div class="dreaming-header-controls">
            <button
              class="btn btn--subtle btn--sm"
              ?disabled=${loading || dreaming.dreamDiaryLoading}
              @click=${() => void this.loadAll(true)}
            >
              ${refreshLoading ? t("dreaming.header.refreshing") : t("dreaming.header.refresh")}
            </button>
            <span class="muted">
              ${
                configuredDreaming.engineOff
                  ? t("dreaming.header.engineOff")
                  : renderSettingsDefaultDescription(
                      t("common.enabled"),
                      configuredDreaming.overridden,
                    )
              }
            </span>
            <button
              class="dreams__phase-toggle ${dreamingOn ? "dreams__phase-toggle--on" : ""}"
              ?disabled=${!canUpdateConfig || loading || configuredDreaming.engineOff}
              @click=${() => this.setEnabled(!dreamingOn)}
            >
              <span class="dreams__phase-toggle-dot"></span>
              <span class="dreams__phase-toggle-label">
                ${dreamingOn ? t("dreaming.header.on") : t("dreaming.header.off")}
              </span>
            </button>
          </div>
        </div>
      </section>
      ${renderDreaming({
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
        active: dreamingOn,
        selectedAgentId,
        shortTermCount: dreamingStatus?.shortTermCount ?? 0,
        promotedCount: dreamingStatus?.promotedToday ?? 0,
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
        onRefreshImports: () => void this.refreshWikiData("wikiImportInsights"),
        onRefreshWikiOverview: () => void this.refreshWikiData("wikiOverview"),
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
      })}
      ${renderDreamingToggleConfirmation({
        open: this.pendingEnabled !== null,
        enabling: this.pendingEnabled === true,
        loading: this.toggleConfirmLoading,
        onConfirm: () => void this.confirmToggle(),
        onCancel: () => this.cancelToggle(),
        hasError: Boolean(dreaming.dreamingStatusError),
      })}
    `;
  }
}

if (!customElements.get("openclaw-agent-memory-panel")) {
  customElements.define("openclaw-agent-memory-panel", AgentMemoryPanel);
}
