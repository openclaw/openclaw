import { asOptionalObjectRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { createDeferred } from "@solidjs/signals";
import { action, createMemo, createOptimistic, createStore, onSettled } from "solid-js";
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
import { showToast } from "../../../lib/toast.ts";
import {
  canCallDreamingMethod,
  clearSettledDreamingRead,
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
} from "./dreaming.ts";
import type { DreamingToggleConfirmationProps } from "./toggle-confirmation.tsx";

registerDreamingEnglish();

type WikiPreviewRequest = {
  page: WikiPagePreview;
  source: { read: WikiPagePreview | Promise<WikiPagePreview> };
};

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
  let toggleRequest:
    | (ReturnType<typeof Promise.withResolvers<void>> & { pending: boolean })
    | undefined;
  let pendingEnabled: boolean | null = null;
  let wikiPreview: WikiPreviewRequest | null = null;
  let pendingWikiRead: { request: WikiPreviewRequest } | null = null;
  const [configOpenScope, setConfigOpenScope] = createOptimistic<DreamingState>();
  const [configOpening, setConfigOpening] = createOptimistic(false);
  const [diaryRequest, setDiaryRequest] = createOptimistic<DreamingState>();
  const [diarySaving, setDiarySaving] = createOptimistic(false);
  let diaryPresentationLifetime = Promise.withResolvers<void>();
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
      retireDiaryPresentation();
      // Retain published data in a new owner; retired reads can only mutate the old state.
      dreaming = {
        ...dreaming,
        resourceReads: {},
        get configSnapshot() {
          return context.runtimeConfig.state.configSnapshot;
        },
      };
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
      retireToggle();
    },
    onSnapshot: applyGatewaySnapshot,
    ensureInitialData: ({ snapshot }) => {
      if (selectedAgentId && hasOperatorReadAccess(snapshot.hello?.auth ?? null)) {
        void loadResources();
        if (wikiPreview && pendingWikiRead?.request === wikiPreview) {
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
    retireDiaryPresentation();
    wikiPreview = null;
    pendingWikiRead = null;
    retireToggle();
    pendingEnabled = null;
  }

  function retireDiaryPresentation() {
    diaryPresentationLifetime.resolve();
    diaryPresentationLifetime = Promise.withResolvers<void>();
  }

  const openConfig = async () => {
    const scope = captureTaskScope();
    if (!scope || !isTaskScopeCurrent(scope)) {
      return;
    }
    const retired = diaryPresentationLifetime.promise;
    const pending = Promise.race([context.runtimeConfig.openFile(), retired]);
    // The runtime owner publishes admission before the presentation action starts.
    await Promise.resolve();
    await presentConfigOpen(scope, pending);
  };

  const presentConfigOpen = action(function* (scope: DreamingTaskScope, pending: Promise<unknown>) {
    try {
      if (isTaskScopeCurrent(scope)) {
        setConfigOpenScope(scope.state);
        setConfigOpening(true);
      }
      yield pending;
    } catch (error) {
      // Expected failures already use the runtime owner's toast contract.
      if (isTaskScopeCurrent(scope)) {
        showToast({ message: formatUiError(error) });
      }
    }
  });

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
    await runDiaryAction(method, scope);
  }

  async function runDiaryAction(method: DreamDiaryActionMethod, scope = captureTaskScope()) {
    if (!scope || !isTaskScopeCurrent(scope) || scope.state.dreamDiaryActionLoading) {
      return;
    }
    const retired = diaryPresentationLifetime.promise;
    const pending = runDreamingTask(
      (current) => runDreamDiaryAction(current, method, () => isTaskScopeCurrent(scope)),
      scope,
    );
    // Publish owner admission before joining its operation to the presentation action.
    await Promise.resolve();
    await presentDiaryAction(scope, pending, retired);
  }

  const presentDiaryAction = action(function* (
    scope: DreamingTaskScope,
    pending: Promise<unknown>,
    retired: Promise<void>,
  ) {
    if (isTaskScopeCurrent(scope)) {
      setDiaryRequest(scope.state);
      setDiarySaving(true);
    }
    yield Promise.race([pending, retired]);
  });

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
      toggleRequest?.pending ||
      pendingEnabled !== null
    ) {
      return;
    }
    pendingEnabled = enabled;
    dreaming.dreamingStatusError = null;
    clearSettledDreamingRead(dreaming, "dreamingStatus");
    notify();
  }

  function cancelToggle() {
    if (toggleRequest?.pending) {
      return;
    }
    pendingEnabled = null;
    retireToggle();
    dreaming.dreamingStatusError = null;
    clearSettledDreamingRead(dreaming, "dreamingStatus");
    notify();
  }

  function retireToggle() {
    // A retired transport may never settle; release its pending presentation now.
    toggleRequest?.resolve();
    toggleRequest = undefined;
  }

  function confirmToggle(): Promise<void> | undefined {
    const enabled = pendingEnabled;
    if (
      enabled == null ||
      toggleRequest?.pending ||
      !canCallDreamingMethod(dreaming, "config.patch", "operator.admin")
    ) {
      return undefined;
    }
    const scope = captureTaskScope();
    if (!scope) {
      return undefined;
    }
    const request = { ...Promise.withResolvers<void>(), pending: true };
    toggleRequest = request;
    dreaming.dreamingStatusError = null;
    clearSettledDreamingRead(dreaming, "dreamingStatus");
    // The dialog can disappear before it consumes a terminal rejection.
    void request.promise.catch(() => undefined);
    void updateToggle(scope, enabled)
      .then(request.resolve, request.reject)
      .finally(() => {
        if (toggleRequest === request) {
          request.pending = false;
          notify();
        }
      });
    return request.promise;
  }

  async function updateToggle(scope: DreamingTaskScope, enabled: boolean) {
    const runtimeConfig = context.runtimeConfig;
    const canDispatch = () =>
      isTaskScopeCurrent(scope) &&
      context.runtimeConfig === runtimeConfig &&
      canCallDreamingMethod(scope.state, "config.patch", "operator.admin");
    const updated = await runDreamingTask(
      (dreamingState) => updateDreamingEnabled(dreamingState, runtimeConfig, enabled, canDispatch),
      scope,
    );
    if (!isTaskScopeCurrent(scope) || context.runtimeConfig !== runtimeConfig) {
      return;
    }
    if (!updated) {
      throw new Error(dreaming.dreamingStatusError ?? t("dreaming.toggleConfirmation.failed"));
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
    const loading =
      (dreaming.resourceReads.dreamingStatus?.pending ?? false) || dreaming.dreamingModeSaving;
    const canUpdateConfig = canCallDreamingMethod(dreaming, "config.patch", "operator.admin");
    const canRunAction = (method: DreamDiaryActionMethod) =>
      canCallDreamingMethod(dreaming, method, "operator.write");
    const refreshLoading =
      (dreaming.resourceReads.dreamingStatus?.pending ?? false) ||
      (dreaming.resourceReads.dreamDiary?.pending ?? false);

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
        statusError: dreaming.dreamingStatusError,
        readStatus: () => readResource(resourceReads.dreamingStatus()),
        readStatusData: () => statusDataRead(),
        readDiary: () => readResource(resourceReads.dreamDiary()),
        readImports: () => readResource(resourceReads.wikiImportInsights()),
        readOverview: () => readResource(resourceReads.wikiOverview()),
        modeSaving: dreaming.dreamingModeSaving,
        dreamDiaryLoading: dreaming.resourceReads.dreamDiary?.pending ?? false,
        dreamDiaryActionMessage: dreaming.dreamDiaryActionMessage,
        dreamDiaryActionArchivePath: dreaming.dreamDiaryActionArchivePath,
        dreamDiaryContent: dreaming.dreamDiaryContent,
        memoryWikiEnabled: isPluginEnabledInConfigSnapshot(
          configState.configSnapshot,
          "memory-wiki",
          { enabledByDefault: false },
        ),
        wikiImportInsightsLoading: dreaming.resourceReads.wikiImportInsights?.pending ?? false,
        wikiImportInsights: dreaming.wikiImportInsights,
        wikiOverviewLoading: dreaming.resourceReads.wikiOverview?.pending ?? false,
        wikiOverview: dreaming.wikiOverview,
        onRefreshDiary: () =>
          void runDreamingTask((current) => loadDreamingResource(current, "dreamDiary")),
        onRefreshImports: () => void loadResources("wikiImportInsights"),
        onRefreshWikiOverview: () => void loadResources("wikiOverview"),
        onOpenConfig: openConfig,
        onOpenWikiPage: openWikiPreview,
        onCloseWikiPreview: () => {
          wikiPreview = null;
          pendingWikiRead = null;
          notify();
        },
        wikiPreview: wikiPreview
          ? {
              request: wikiPreview,
              page: wikiPreview.page,
              readKey: wikiPreview.source,
              readPage: wikiPage,
            }
          : null,
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
        disabled: !canUpdateConfig,
        onConfirm: confirmToggle,
        onCancel: cancelToggle,
        completion: toggleRequest?.pending ? undefined : toggleRequest?.promise,
      } satisfies DreamingToggleConfirmationProps,
    };
  }

  function openWikiPreview(lookup: string): Promise<void> {
    const scope = captureTaskScope();
    if (!scope || !scope.state.connected) {
      return Promise.resolve();
    }
    const page = { title: pathDisplayName(lookup), path: lookup, content: "" };
    const request: WikiPreviewRequest = { page, source: { read: page } };
    wikiPreview = request;
    return loadWikiPreview(request);
  }

  async function loadWikiPreview(request: WikiPreviewRequest) {
    const scope = captureTaskScope();
    if (!scope) {
      return;
    }
    const issued = Promise.withResolvers<WikiPagePreview>();
    const operation = { request };
    pendingWikiRead = operation;
    request.source = { read: issued.promise };
    // A closed/retired preview can lose its last reader before the request fails.
    void issued.promise.catch(() => undefined);
    notify();
    const isCurrent = () =>
      wikiPreview === request && pendingWikiRead === operation && isTaskScopeCurrent(scope);
    try {
      const page = await openWikiPage(request.page.path);
      if (!isCurrent()) {
        // Keep the displayed read pending until reconnect replaces it.
        return;
      }
      if (page) {
        request.page = page;
        issued.resolve(page);
      } else {
        issued.reject(new Error(t("dreaming.wiki.pageNotFound", { lookup: request.page.path })));
      }
    } catch (error) {
      if (isCurrent()) {
        issued.reject(error);
      }
    } finally {
      if (isCurrent()) {
        pendingWikiRead = null;
        notify();
      }
    }
  }
  const projection = projectMutableSource(context, read);
  // Keep the action affordance outside the held owner snapshot and retire it on scope changes.
  const diaryActionBusy = () => {
    projection.revision();
    return diaryRequest() === dreaming && diarySaving();
  };
  const diaryOutcome = createMemo(() => {
    projection.revision();
    return {
      message: dreaming.dreamDiaryActionMessage,
      archivePath: dreaming.dreamDiaryActionArchivePath,
    };
  });
  function resourceRead<T>(key: DreamingResourceKey, readValue: (state: DreamingState) => T) {
    const scope = createMemo(() => {
      projection.revision();
      return dreaming.resourceReads[key] ? dreaming : null;
    });
    const scoped = createMemo(() => {
      const current = scope();
      if (!current) {
        return () => ({ value: readValue(dreaming) });
      }
      const request = createMemo(() => {
        projection.revision();
        return current.resourceReads[key];
      });
      const load = (): { value: T; error?: unknown } | Promise<{ value: T; error?: unknown }> => {
        const issued = request();
        return issued
          ? issued.promise.then(
              () => ({ value: readValue(current) }),
              (error: unknown) => ({ value: readValue(current), error }),
            )
          : { value: readValue(current) };
      };
      const value = readValue(current);
      // A new scope suspends its first read; same-agent reconnects retain accepted data.
      return value === null
        ? createDeferred(load)
        : createDeferred(load, { loadingValue: { value } });
    });
    return () => scoped()();
  }
  function readResource<T>(result: { value: T; error?: unknown }): T {
    if ("error" in result) {
      throw result.error;
    }
    return result.value;
  }
  const resourceReads = {
    dreamingStatus: resourceRead("dreamingStatus", (state) => state.dreamingStatus),
    dreamDiary: resourceRead("dreamDiary", (state) => state.dreamDiaryContent),
    wikiImportInsights: resourceRead("wikiImportInsights", (state) => state.wikiImportInsights),
    wikiOverview: resourceRead("wikiOverview", (state) => state.wikiOverview),
  };
  const statusDataRead = createMemo(() => {
    config.read();
    const status = resolveConfiguredDreaming(currentConfigObject(context.runtimeConfig.state))
      .engineOff
      ? null
      : resourceReads.dreamingStatus().value;
    return {
      shortTermCount: status?.shortTermCount ?? 0,
      promotedCount: status?.promotedToday ?? 0,
      phases: status?.phases,
      shortTermEntries: status?.shortTermEntries ?? [],
      promotedEntries: status?.promotedEntries ?? [],
      nextCycle: resolveDreamingNextCycle(status),
      timezone: status?.timezone ?? null,
    };
  });
  const wikiSource = createMemo(() => {
    projection.revision();
    return wikiPreview?.source ?? null;
  });
  const wikiPage: () => WikiPagePreview | null = createMemo(() => wikiSource()?.read ?? null);
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
    configOpening: () => {
      projection.revision();
      return configOpening() && configOpenScope() === dreaming;
    },
    diaryActionBusy,
    diaryOutcome,
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
