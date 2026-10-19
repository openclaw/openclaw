import { asOptionalObjectRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { createStore, onSettled } from "solid-js";
import type { ApplicationContext, ApplicationGateway } from "../../../app/context.ts";
import { hasOperatorReadAccess } from "../../../app/operator-access.ts";
import {
  showConfirmDialog,
  type ConfirmDialogOptions,
} from "../../../components/confirm-dialog.ts";
import { t } from "../../../i18n/index.ts";
import { registerDreamingEnglish } from "../../../i18n/locales/en-dreaming.ts";
import { currentConfigObject } from "../../../lib/config/config-state-model.ts";
import { formatUiError } from "../../../lib/format-error.ts";
import { formatTimeMs } from "../../../lib/format.ts";
import { GatewayPageBinding, type GatewayPageChange } from "../../../lib/gateway-page-binding.ts";
import { pathDisplayName } from "../../../lib/path-display.ts";
import { isPluginEnabledInConfigSnapshot } from "../../../lib/plugin-activation.ts";
import { projectOwner, projectMutableSource } from "../../../lib/reactive/projection.ts";
import {
  canCallDreamingMethod,
  copyDreamingArchivePath,
  createDreamingState,
  createDreamingViewState,
  DREAM_PHRASE_KEYS,
  loadDreamingResource,
  resolveConfiguredDreaming,
  runDreamDiaryAction,
  updateDreamingEnabled,
  type DreamDiaryActionMethod,
  type DreamingResourceKey,
  type DreamingState,
  type DreamingViewState,
  type WikiPagePreview,
  type WikiPreviewState,
} from "./dreaming.ts";
import type { DreamingToggleConfirmationProps } from "./toggle-confirmation.tsx";

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

export type AgentMemoryState = ReturnType<typeof createAgentMemory>;

export type AgentMemoryTarget = {
  read(): string | null;
  subscribe(notify: () => void): () => void;
};

export function createAgentMemory(
  context: ApplicationContext,
  getInitialAgentTarget: () => AgentMemoryTarget,
) {
  const config = projectOwner(context.runtimeConfig, (source) => source.state);
  let active = false;
  let publish = () => {};
  let dreaming = createDreamingState();
  let toggleConfirmLoading = false;
  let pendingEnabled: boolean | null = null;
  let wikiPreview: WikiPreviewState | null = null;
  const [viewState, setViewState] = createStore(createDreamingViewState());
  function updateViewState(update: (draft: DreamingViewState) => void) {
    const now = Date.now();
    setViewState((draft) => {
      update(draft);
      if (now - draft.dreamLastSwap > 6_000) {
        draft.dreamLastSwap = now;
        draft.dreamIndex = (draft.dreamIndex + 1) % DREAM_PHRASE_KEYS.length;
      }
    });
  }
  function notify() {
    if (!active) {
      return;
    }
    updateViewState(() => {});
    publish();
  }
  const gateway = new GatewayPageBinding(notify, {
    getGateway: () => context.gateway,
    invalidateRequests: ({ identityChanged }) => {
      // Retain published data in a new owner; retired reads can only mutate the old state.
      dreaming = {
        ...dreaming,
        get configSnapshot() {
          return context.runtimeConfig.state.configSnapshot;
        },
      };
      dreaming.dreamingStatusLoading = false;
      dreaming.dreamDiaryLoading = false;
      dreaming.wikiImportInsightsLoading = false;
      dreaming.wikiOverviewLoading = false;
      if (
        !identityChanged &&
        dreaming.dreamDiaryActionLoading &&
        !dreaming.dreamDiaryActionMessage
      ) {
        dreaming.dreamDiaryActionMessage = {
          kind: "error",
          text: t("dreaming.actions.actionInterrupted"),
        };
      }
      dreaming.dreamDiaryActionLoading = false;
      dreaming.dreamingModeSaving = false;
      toggleConfirmLoading = false;
    },
    onSnapshot: applyGatewaySnapshot,
    ensureInitialData: ({ snapshot }) => {
      if (selectedAgentId && hasOperatorReadAccess(snapshot.hello?.auth ?? null)) {
        void loadResources();
        if (wikiPreview?.loading) {
          void loadWikiPreview(wikiPreview);
        }
      }
    },
  });
  let selectedAgentId: string | null = null;
  function captureTaskScope(): DreamingTaskScope | null {
    const source = gateway.gateway;
    if (!source) {
      return null;
    }
    return { gateway: source, epoch: gateway.epoch, state: dreaming };
  }

  function isTaskScopeCurrent(scope: DreamingTaskScope): boolean {
    return (
      active &&
      gateway.gateway === scope.gateway &&
      gateway.epoch === scope.epoch &&
      context.gateway === scope.gateway &&
      dreaming === scope.state
    );
  }

  function resetTransientState() {
    wikiPreview = null;
    toggleConfirmLoading = false;
    pendingEnabled = null;
  }

  function createGatewayState(snapshot = context.gateway.snapshot): DreamingState {
    return {
      ...createDreamingState({
        client: snapshot.client,
        connected: snapshot.phase === "connected",
        hello: snapshot.hello,
        selectedAgentId,
      }),
      get configSnapshot() {
        return context.runtimeConfig.state.configSnapshot;
      },
    };
  }

  function applyGatewaySnapshot({ snapshot, initial, identityChanged }: GatewayPageChange) {
    if (
      initial ||
      identityChanged ||
      (snapshot.phase === "connected" && !hasOperatorReadAccess(snapshot.hello?.auth ?? null))
    ) {
      dreaming = createGatewayState(snapshot);
      if (!initial) {
        resetTransientState();
      }
    } else {
      dreaming.connected = snapshot.phase === "connected";
      dreaming.hello = snapshot.hello;
    }
    notify();
  }

  function setAgentId(value: string) {
    const agentId = value.trim() || null;
    if (selectedAgentId === agentId) {
      return;
    }
    selectedAgentId = agentId;
    if (!active) {
      return;
    }
    gateway.invalidate();
    resetTransientState();
    dreaming = createGatewayState();
    if (agentId && dreaming.connected) {
      void loadResources();
    }
    notify();
  }

  async function runDreamingTask<T>(
    task: (state: DreamingState) => Promise<T>,
    scope = captureTaskScope(),
  ): Promise<T | undefined> {
    if (!scope || !isTaskScopeCurrent(scope)) {
      return undefined;
    }
    const result = task(scope.state);
    notify();
    try {
      const value = await result;
      return isTaskScopeCurrent(scope) ? value : undefined;
    } finally {
      if (isTaskScopeCurrent(scope)) {
        notify();
      }
    }
  }

  async function confirmDreamingTask(
    method: DreamDiaryActionMethod,
    confirmation: ConfirmDialogOptions,
  ) {
    const scope = captureTaskScope();
    if (!scope || !(await showConfirmDialog(confirmation)) || !isTaskScopeCurrent(scope)) {
      return;
    }
    await runDreamingTask(
      (current) => runDreamDiaryAction(current, method, () => isTaskScopeCurrent(scope)),
      scope,
    );
  }

  function runDiaryAction(method: DreamDiaryActionMethod) {
    const scope = captureTaskScope();
    return scope
      ? runDreamingTask(
          (current) => runDreamDiaryAction(current, method, () => isTaskScopeCurrent(scope)),
          scope,
        )
      : undefined;
  }

  async function loadResources(
    resource: DreamingResourceKey | "all" = "all",
    refreshConfig = resource !== "all",
  ) {
    const scope = captureTaskScope();
    if (
      !scope?.state.selectedAgentId ||
      (resource === "all" && (!scope.state.client || !scope.state.connected))
    ) {
      return;
    }
    const runtimeConfig = context.runtimeConfig;
    await (refreshConfig ? runtimeConfig.refresh() : runtimeConfig.ensureLoaded());
    if (!isTaskScopeCurrent(scope) || context.runtimeConfig !== runtimeConfig) {
      return;
    }
    if (resource === "all") {
      await Promise.all(
        (["dreamingStatus", "dreamDiary", "wikiImportInsights", "wikiOverview"] as const).map(
          (key) => runDreamingTask((current) => loadDreamingResource(current, key), scope),
        ),
      );
    } else {
      await runDreamingTask((current) => loadDreamingResource(current, resource), scope);
    }
  }

  function setEnabled(enabled: boolean) {
    if (
      !canCallDreamingMethod(dreaming, "config.patch", "operator.admin") ||
      dreaming.dreamingModeSaving ||
      toggleConfirmLoading ||
      pendingEnabled !== null
    ) {
      return;
    }
    pendingEnabled = enabled;
    dreaming.dreamingStatusError = null;
    notify();
  }

  function cancelToggle() {
    if (toggleConfirmLoading) {
      return;
    }
    pendingEnabled = null;
    dreaming.dreamingStatusError = null;
    notify();
  }

  async function confirmToggle() {
    const enabled = pendingEnabled;
    if (
      enabled == null ||
      toggleConfirmLoading ||
      !canCallDreamingMethod(dreaming, "config.patch", "operator.admin")
    ) {
      return;
    }
    toggleConfirmLoading = true;
    dreaming.dreamingStatusError = null;
    const scope = captureTaskScope();
    const runtimeConfig = context.runtimeConfig;
    if (!scope) {
      toggleConfirmLoading = false;
      return;
    }
    try {
      const canDispatch = () =>
        isTaskScopeCurrent(scope) &&
        context.runtimeConfig === runtimeConfig &&
        canCallDreamingMethod(scope.state, "config.patch", "operator.admin");
      const updated = await runDreamingTask(
        (dreamingState) =>
          updateDreamingEnabled(dreamingState, runtimeConfig, enabled, canDispatch),
        scope,
      );
      if (!isTaskScopeCurrent(scope) || context.runtimeConfig !== runtimeConfig) {
        return;
      }
      if (!updated) {
        dreaming.dreamingStatusError ??= t("dreaming.toggleConfirmation.failed");
        return;
      }
      await runtimeConfig.refresh();
      if (!isTaskScopeCurrent(scope) || context.runtimeConfig !== runtimeConfig) {
        return;
      }
      await runDreamingTask((current) => loadDreamingResource(current, "dreamingStatus"), scope);
      if (!isTaskScopeCurrent(scope)) {
        return;
      }
      pendingEnabled = null;
    } finally {
      if (isTaskScopeCurrent(scope)) {
        toggleConfirmLoading = false;
        notify();
      }
    }
  }

  async function openWikiPage(lookup: string): Promise<WikiPagePreview | null> {
    const scope = captureTaskScope();
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
    if (!isTaskScopeCurrent(scope) || scope.state.selectedAgentId !== agentId) {
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

  function read() {
    const configState = context.runtimeConfig.state;
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

    return {
      header: { configuredDreaming, dreamingOn, loading, canUpdateConfig, refreshLoading },
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
        active: dreamingOn,
        selectedAgentId: dreaming.selectedAgentId ?? "",
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
          void runDreamingTask((current) => loadDreamingResource(current, "dreamDiary")),
        onRefreshImports: () => void loadResources("wikiImportInsights"),
        onRefreshWikiOverview: () => void loadResources("wikiOverview"),
        onOpenConfig: () => void context.runtimeConfig.openFile(),
        onOpenWikiPage: openWikiPreview,
        onCloseWikiPreview: () => {
          wikiPreview = null;
          notify();
        },
        wikiPreview: wikiPreview ? { ...wikiPreview, request: wikiPreview } : null,
        onBackfillDiary: () => void runDiaryAction("doctor.memory.backfillDreamDiary"),
        onCopyDreamingArchivePath: () => void runDreamingTask(copyDreamingArchivePath),
        onDedupeDreamDiary: () =>
          void confirmDreamingTask("doctor.memory.dedupeDreamDiary", {
            title: t("dreaming.scene.dedupeDiary"),
            message: t("dreaming.actions.confirmDedupeDescription"),
            confirmLabel: t("dreaming.scene.dedupeDiary"),
            danger: true,
          }),
        onResetDiary: () => void runDiaryAction("doctor.memory.resetDreamDiary"),
        onResetGroundedShortTerm: () => void runDiaryAction("doctor.memory.resetGroundedShortTerm"),
        onRepairDreamingArtifacts: () =>
          void confirmDreamingTask("doctor.memory.repairDreamingArtifacts", {
            title: t("dreaming.scene.repairCache"),
            message: t("dreaming.actions.confirmRepairDescription"),
            confirmLabel: t("dreaming.scene.repairCache"),
          }),
      },
      toggle: {
        open: pendingEnabled !== null,
        enabling: pendingEnabled === true,
        loading: toggleConfirmLoading,
        disabled: !canUpdateConfig,
        onConfirm: () => void confirmToggle(),
        onCancel: () => cancelToggle(),
        hasError: Boolean(dreaming.dreamingStatusError),
      } satisfies DreamingToggleConfirmationProps,
    };
  }

  function openWikiPreview(lookup: string): Promise<void> {
    const scope = captureTaskScope();
    if (!scope || !scope.state.connected) {
      return Promise.resolve();
    }
    const request: WikiPreviewState = {
      page: { title: pathDisplayName(lookup), path: lookup, content: "" },
      loading: true,
      error: null,
    };
    wikiPreview = request;
    notify();
    return loadWikiPreview(request);
  }

  async function loadWikiPreview(request: WikiPreviewState) {
    const scope = captureTaskScope();
    if (!scope) {
      return;
    }
    const lookup = request.page.path;
    try {
      const page = await openWikiPage(lookup);
      if (wikiPreview !== request || !isTaskScopeCurrent(scope)) {
        return;
      }
      if (page) {
        request.page = page;
      } else {
        request.error = t("dreaming.wiki.pageNotFound", { lookup });
      }
    } catch (error) {
      if (wikiPreview === request && isTaskScopeCurrent(scope)) {
        request.error = formatUiError(error);
      }
    } finally {
      if (wikiPreview === request && isTaskScopeCurrent(scope)) {
        request.loading = false;
        notify();
      }
    }
  }
  const projection = projectMutableSource(context, read);
  publish = projection.publish;
  onSettled(() => {
    const agentTarget = getInitialAgentTarget();
    const syncAgent = () => setAgentId(agentTarget.read() ?? "");
    // Agent receipts invalidate prior requests and replace their resource state synchronously.
    const stopAgent = agentTarget.subscribe(syncAgent);
    syncAgent();
    active = true;
    gateway.connect();
    return () => {
      stopAgent();
      active = false;
      publish = () => {};
      resetTransientState();
      dreaming = createDreamingState();
      gateway.dispose();
    };
  });
  return {
    loadResources,
    setEnabled,
    view() {
      config.read();
      const model = projection.read();
      return {
        ...model,
        dreaming: {
          ...model.dreaming,
          viewState,
          onViewStateChange: updateViewState,
        },
      };
    },
  };
}
