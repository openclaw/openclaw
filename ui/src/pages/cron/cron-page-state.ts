import { createSignal, onSettled } from "solid-js";
import { cronRunEntryMatchesLink } from "../../../../src/cron/run-link.js";
import type { CronJob, CronRunLogEntry, CronScratchGetResult } from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { hasOperatorReadAccess, readGatewayOperatorAccess } from "../../app/operator-access.ts";
import { showConfirmDialog } from "../../components/confirm-dialog.ts";
import { registerCronEnglish } from "../../i18n/locales/en-cron.ts";
import { watchAgentScope, watchSelectedAgent } from "../../lib/agents/index.ts";
import { buildQualifiedChatModelValue } from "../../lib/chat/model-ref.ts";
import {
  addCronJob,
  cancelCronEdit,
  createInitialCronState,
  hasCronFormErrors,
  invalidateCronMutation,
  invalidateCronRefresh,
  loadCronJobsPage,
  loadCronStatus,
  normalizeCronFormState,
  removeCronJob,
  runCronJob,
  startCronClone,
  startCronEdit,
  toggleCronJob,
  updateCronJobsFilter,
  validateCronForm,
} from "../../lib/cron/index.ts";
import { loadCronRuns, loadCronRunsForJob, updateCronRunsFilter } from "../../lib/cron/runs.ts";
import type { CronFormState, CronState } from "../../lib/cron/types.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { isGatewayAvailable } from "../../lib/gateway-availability.ts";
import { createGatewayConnectionLifecycle } from "../../lib/gateway-connection-lifecycle.ts";
import { formatMissingOperatorReadScopeMessage } from "../../lib/gateway-errors.ts";
import {
  loadModelCatalog,
  modelCatalogRefreshError,
  subscribeModelCatalogCache,
} from "../../lib/model-catalog-store.ts";
import { registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";
import { projectOwner, projectMutableSource } from "../../lib/reactive/projection.ts";
import { useVisiblePoll } from "../../lib/reactive/visible-poll.ts";
import {
  createDeliveryConversations,
  invalidateStaleDeliveryRoute,
  requiresDirectoryReload,
} from "./delivery-conversations.ts";
import { createCronEventEditor } from "./event-editor.ts";
import { resolveCronEventPatch, validateCronEventSelection } from "./event-source.ts";
import { createCronRouteSelection, resolveCronRouteData } from "./route-model.ts";
import { createCronRunTranscript } from "./run-transcript.tsx";

registerEnglishCatalog(registerCronEnglish);

type CronListTab = "tasks" | "activity";
type CronDetailTab = "settings" | "history";

/** Owns page presentation; cron admission and mutation chains remain synchronous. */
export function createCronPage(context: () => ApplicationContext, host: () => HTMLElement) {
  let routeSearch = "";
  let cron = createInitialCronState();
  const [cronModelSuggestions, setCronModelSuggestions] = createSignal<string[]>([]);
  const [modelSuggestionsError, setModelSuggestionsError] = createSignal<string | null>(null);
  const [listTab, setListTab] = createSignal<CronListTab>("tasks");
  const [detailTab, setDetailTab] = createSignal<CronDetailTab>("settings");
  const [heartbeatScratch, setHeartbeatScratch] = createSignal("");
  let active = false;
  const cleanups: Array<() => void> = [];
  const gateway = createGatewayConnectionLifecycle({ client: null, phase: "stopped" });
  let boundContext: ApplicationContext | null = null;
  let gatewayAvailable = false;
  const projection = projectMutableSource(null, () => cron);
  const agents = projectOwner(context().agents, (source) => source.state);
  const channels = projectOwner(context().channels, (source) => source.state);
  const runtimeConfig = projectOwner(context().runtimeConfig, (source) => source.state);
  const runTranscript = createCronRunTranscript(publish, () => {
    const scope = gateway.capture();
    const current = cron;
    return scope
      ? {
          client: scope.client,
          isCurrent: () =>
            active && host().isConnected && gateway.isCurrent(scope) && cron === current,
        }
      : null;
  });
  const routeSelection = createCronRouteSelection();
  let pendingRunScroll = false;
  const runRows = new Map<HTMLElement, () => CronRunLogEntry>();
  let modelSuggestionsRequest: { state: CronState; agentId: string } | null = null;
  let stopModelSuggestions: (() => void) | undefined;
  const deliveryDirectory = createDeliveryConversations({
    currentCronState: () => cron,
    canManage: canManageCron,
    captureConnection: () => gateway.capture(),
    isCurrentConnection: (scope) => gateway.isCurrent(scope),
  });
  const eventSource = createCronEventEditor({
    currentCronState: () => cron,
    context,
    canManage: canManageCron,
    isConnected: () => active && host().isConnected,
    captureConnection: () => gateway.capture(),
    isCurrentConnection: (scope) => gateway.isCurrent(scope),
    notify: publish,
  });
  let heartbeatScratchRequest = 0;
  const safetyRefresh = useVisiblePoll(600_000, () => ensureInitialData(true));
  const observeAgentScope = watchAgentScope((scopeId, intentChanged) => {
    if (!intentChanged) {
      // Hydration refines scope without replacing operator intent or drafts.
      cron.cronAgentId = scopeId;
      void refreshCron();
      void loadModelSuggestions(cron);
      if ((cron.cronEditingJob || cron.cronCreateOpen) && !cron.cronForm.agentId.trim()) {
        void deliveryDirectory.load();
      }
      publish();
      return;
    }
    routeSelection.target = null;
    // Replacing the owner retires results from the previous agent scope.
    resetGatewayState(context().gateway.snapshot);
    cron.cronAgentId = scopeId;
    setListTab("tasks");
    setDetailTab("settings");
    ensureInitialData();
    publish();
  });
  function canManageCron(): boolean {
    return readGatewayOperatorAccess(context().gateway.snapshot).canAdmin;
  }

  function bindContext() {
    cleanups.splice(0).forEach((stop) => stop());
    const currentContext = context();
    const sourceChanged = boundContext !== null && boundContext.gateway !== currentContext.gateway;
    let first = boundContext === null || sourceChanged;
    boundContext = currentContext;
    agents.replaceSource(currentContext.agents);
    channels.replaceSource(currentContext.channels);
    runtimeConfig.replaceSource(currentContext.runtimeConfig);
    if (sourceChanged) {
      gateway.invalidate();
    }
    const applySnapshot = () => {
      if (!active || context() !== currentContext) {
        return;
      }
      const snapshot = currentContext.gateway.snapshot;
      const previousConnected = gateway.capture() !== null;
      const presentationChanged = routeSelection.bind(currentContext.gateway);
      const changed = gateway.transition(snapshot) || presentationChanged;
      if (presentationChanged) {
        gateway.invalidate();
      }
      const nextAvailable = isGatewayAvailable(snapshot);
      if (changed) {
        invalidateCronMutation(cron);
      }
      if (first || presentationChanged || cron.client !== snapshot.client) {
        resetGatewayState(snapshot);
      } else if (changed) {
        invalidateCronRefresh(cron);
        cron.client = snapshot.client;
        cron.connected = snapshot.phase === "connected";
        runTranscript.reconnect();
        heartbeatScratchRequest += 1;
        if (!cron.cronEditingJob && !cron.cronCreateOpen) {
          routeSelection.requested = false;
        }
      }
      if (snapshot.phase === "connected" && !readGatewayOperatorAccess(snapshot).canAdmin) {
        clearHeartbeatScratch();
        deliveryDirectory.clear();
      }
      if (snapshot.phase === "connected" && !hasOperatorReadAccess(snapshot.hello?.auth ?? null)) {
        resetGatewayState(snapshot);
        cron.cronJobsError = formatMissingOperatorReadScopeMessage("scheduled tasks");
      }
      if (snapshot.phase === "connected" && (first || changed)) {
        ensureInitialData(true);
      } else if (!first && !gatewayAvailable && nextAvailable && previousConnected) {
        ensureInitialData(true);
      }
      first = false;
      gatewayAvailable = nextAvailable;
      publish();
    };
    // Gateway receipts retire requests and privileged editor state before reconnecting or losing access.
    cleanups.push(currentContext.gateway.subscribe(applySnapshot));
    applySnapshot();
    cleanups.push(
      observeAgentScope(currentContext.agentSelection),
      watchSelectedAgent(currentContext.agentSelection, (agentId) => {
        if (modelSuggestionsRequest?.agentId !== agentId) {
          void loadModelSuggestions(cron);
        }
      }),
      currentContext.gateway.subscribeEvents((event) => {
        if (active && context() === currentContext && event.event === "cron") {
          void refreshCron({ coalesce: true, event: event.payload });
        }
      }),
    );
  }

  onSettled(() => {
    active = true;
    bindContext();
    // Routed content can settle before its host is attached.
    queueMicrotask(() => {
      if (active && !cron.cronStatus && !cron.cronLoading) {
        ensureInitialData();
      }
    });
    safetyRefresh.start();
    return () => {
      active = false;
      safetyRefresh.stop();
      cleanups.splice(0).forEach((stop) => stop());
      gateway.dispose();
      stopModelSuggestions?.();
      modelSuggestionsRequest = null;
      heartbeatScratchRequest += 1;
      invalidateCronRefresh(cron);
    };
  });

  function publish() {
    if (!active) {
      return;
    }
    if (boundContext !== context()) {
      bindContext();
    }
    preparePanel();
    eventSource.sync();
    projection.publish();
    // The state writer owns route admission; its DOM requests follow this publication's commit.
    onSettled(() => {
      if (active) {
        afterRender();
      }
    });
  }

  function resetGatewayState(snapshot: ApplicationContext["gateway"]["snapshot"]) {
    stopModelSuggestions?.();
    stopModelSuggestions = undefined;
    runTranscript.close();
    clearHeartbeatScratch();
    eventSource.reset();
    invalidateCronRefresh(cron);
    const connected = snapshot.phase === "connected";
    const nextCron = createInitialCronState({
      client: snapshot.client,
      connected,
    });
    nextCron.canRefresh = () => canRefreshCron(nextCron);
    cron = nextCron;
    const routeData = resolveCronRouteData(routeSearch);
    cron.cronSessionFilter = routeData.session;
    routeSelection.requested = false;
    cron.cronAgentId = context().agentSelection.state.scopeId;
    setCronModelSuggestions([]);
    deliveryDirectory.retireEditor();
    setModelSuggestionsError(null);
    modelSuggestionsRequest = null;
  }

  function canRefreshCron(current: CronState = cron) {
    return (
      active &&
      host().isConnected &&
      cron === current &&
      isGatewayAvailable(context().gateway.snapshot) &&
      hasOperatorReadAccess(context().gateway.snapshot.hello?.auth ?? null) &&
      document.visibilityState !== "hidden"
    );
  }

  function ensureInitialData(forceRefresh = false) {
    if (!canRefreshCron() || !cron.connected || !cron.client) {
      return;
    }
    if (!context().agents.state.agentsList && !context().agents.state.agentsLoading) {
      void context().agents.ensureList();
    }
    if (forceRefresh || (!cron.cronStatus && !cron.cronLoading)) {
      void refreshCron({ coalesce: true });
    } else if (!cron.cronRuns.length && !cron.cronRunsLoadingMore) {
      void runCronTask(loadCronRuns);
    }
    if (forceRefresh || modelSuggestionsRequest?.state !== cron) {
      void loadModelSuggestions(cron);
    }
  }

  function publishCronState(cronState: CronState = cron) {
    if (cron === cronState) {
      publish();
    }
  }

  let lastPanelKey: string | null = null;

  function setRouteSearch(search: string) {
    if (search === routeSearch) {
      return;
    }
    routeSearch = search;
    runTranscript.close();
    cron.cronError = null;
    const routeData = resolveCronRouteData(search);
    if (JSON.stringify(cron.cronSessionFilter) !== JSON.stringify(routeData.session)) {
      resetGatewayState(context().gateway.snapshot);
      ensureInitialData();
    }
    setListTab("tasks");
    setDetailTab("settings");
    routeSelection.target = routeData.jobId || routeData.session ? routeData : null;
    routeSelection.requested = false;
    cron.cronRunsRunId = null;
    pendingRunScroll = false;
    publish();
  }

  function preparePanel() {
    // Retire transcript requests before displaying another panel target.
    const editingJobId = cron.cronEditingJob?.id ?? null;
    const mode = editingJobId ? "job" : cron.cronCreateOpen ? "create" : "overview";
    const panelKey = `${mode}:${editingJobId ?? ""}`;
    if (panelKey !== lastPanelKey) {
      lastPanelKey = panelKey;
      runTranscript.close();
      setDetailTab(editingJobId && cron.cronRunsRunId ? "history" : "settings");
      const scroller = host().closest(".content");
      if (scroller instanceof HTMLElement && typeof scroller.scrollTo === "function") {
        scroller.scrollTo({ top: 0 });
      }
    }
  }

  function afterRender() {
    routeSelection.resolveLoadedSession(cron, selectJob);
    const routeData = routeSelection.target;
    const client = cron.client;
    if (routeData?.jobId && client && cron.connected && !routeSelection.requested) {
      const connectionScope = gateway.capture();
      void runCronTask((current) =>
        routeSelection.resolve(
          current,
          () =>
            active &&
            host().isConnected &&
            cron === current &&
            connectionScope !== null &&
            gateway.isCurrent(connectionScope),
          (job, runId) => selectJob(job, runId),
        ),
      );
    }
    const runId = cron.cronRunsRunId;
    if (pendingRunScroll && runId) {
      const row = [...runRows].find(([, entry]) => cronRunEntryMatchesLink(runId, entry()));
      if (row) {
        row[0].scrollIntoView?.({ block: "nearest" });
        pendingRunScroll = false;
      }
    }
  }

  async function refreshCron(options: { coalesce?: boolean; event?: unknown } = {}) {
    const cronState = cron;
    if (!canRefreshCron(cronState) || !cronState.connected || !cronState.client) {
      return;
    }
    void runCronTask((current) => loadCronRuns(current, options));
    void context().channels.refresh(false);
    await Promise.all([
      runCronTask((current) => loadCronStatus(current, options)),
      runCronTask((current) =>
        loadCronJobsPage(current, { tableFilters: true, event: options.event }),
      ),
    ]);
  }

  function updateJobsFilters(patch: Parameters<typeof updateCronJobsFilter>[1]) {
    void runCronTask(async (cronState) => {
      updateCronJobsFilter(cronState, patch);
      await loadCronJobsPage(cronState, { append: false, tableFilters: true });
    });
  }

  async function loadModelSuggestions(cronState: CronState) {
    const client = cronState.client;
    const agentId = context().agentSelection.state.selectedId;
    // Last-good suggestions belong to one agent, including when its successor has no catalog.
    if (modelSuggestionsRequest?.agentId !== agentId) {
      modelSuggestionsRequest = null;
      setCronModelSuggestions([]);
      setModelSuggestionsError(null);
      publishCronState(cronState);
    }
    if (!client || !agentId || !isGatewayAvailable(context().gateway.snapshot)) {
      return;
    }
    const connectionScope = gateway.capture();
    if (!connectionScope) {
      return;
    }
    stopModelSuggestions ??= subscribeModelCatalogCache(
      client,
      (update) => {
        if (active && cron.client === client && update.type === "invalidated") {
          void loadModelSuggestions(cron);
        }
      },
      () => ({ agentId: context().agentSelection.state.selectedId ?? undefined }),
    );
    const request = { state: cronState, agentId };
    modelSuggestionsRequest = request;
    // Only the latest catalog request may publish rows or errors.
    const isCurrent = () =>
      active &&
      cron === cronState &&
      gateway.isCurrent(connectionScope) &&
      modelSuggestionsRequest === request &&
      context().agentSelection.state.selectedId === agentId;
    try {
      const result = await loadModelCatalog(client, { agentId });
      if (isCurrent()) {
        setCronModelSuggestions(
          result.models
            .filter((entry) => entry.manualSelectionAllowed !== false)
            .map((entry) => buildQualifiedChatModelValue(entry.id, entry.provider)),
        );
        setModelSuggestionsError(modelCatalogRefreshError(result));
        publishCronState(cronState);
      }
    } catch (error) {
      if (isCurrent()) {
        setModelSuggestionsError(formatUiError(error));
        publishCronState(cronState);
      }
    }
  }

  async function runCronTask<T>(task: (cronState: CronState) => Promise<T>): Promise<T> {
    const cronState = cron;
    try {
      const result = task(cronState);
      publishCronState(cronState);
      return await result;
    } finally {
      publishCronState(cronState);
    }
  }

  function runCronAdminTask<T>(task: (cronState: CronState) => Promise<T>): void {
    // Recheck access at dispatch after possible reconnect or downgrade.
    if (!canManageCron()) {
      return;
    }
    void runCronTask(task);
  }

  function patchForm(patch: Partial<CronFormState>) {
    if (!canManageCron()) {
      return;
    }
    const current = cron.cronForm;
    const resolvedPatch = invalidateStaleDeliveryRoute(
      current,
      resolveCronEventPatch(current, patch),
    );
    const next = normalizeCronFormState({ ...cron.cronForm, ...resolvedPatch }, resolvedPatch);
    cron.cronForm = next;
    cron.cronFieldErrors = validateCronForm(cron.cronForm);
    if (requiresDirectoryReload(current, next)) {
      void deliveryDirectory.load();
    }
    publishCronState();
  }

  function selectJob(job: CronJob, runId: string | null = null) {
    clearHeartbeatScratch();
    routeSelection.select(job.id, runId);
    pendingRunScroll = Boolean(runId);
    if (runId) {
      setDetailTab("history");
    }
    cron.cronCreateOpen = false;
    startCronEdit(cron, job);
    // Claim the run pane before awaiting to retire the previous job's history.
    void runCronTask((cronState) => loadCronRunsForJob(cronState, job.id, runId));
    deliveryDirectory.openEditor();
    if (job.payload?.kind === "heartbeat") {
      void loadHeartbeatScratch(cron, job.id, heartbeatScratchRequest);
    }
  }

  function clearHeartbeatScratch() {
    heartbeatScratchRequest += 1;
    setHeartbeatScratch("");
  }

  async function loadHeartbeatScratch(cronState: CronState, jobId: string, requestId: number) {
    const client = cronState.client;
    if (!canManageCron() || !client || !cronState.connected) {
      return;
    }
    const connectionScope = gateway.capture();
    if (!connectionScope) {
      return;
    }
    // Revalidate scratch access, connection, and selection after the request.
    const isCurrent = () =>
      cron === cronState &&
      heartbeatScratchRequest === requestId &&
      gateway.isCurrent(connectionScope) &&
      canManageCron() &&
      cronState.cronEditingJob?.id === jobId &&
      cronState.cronForm.payloadKind === "heartbeat";
    try {
      const result = await client.request<CronScratchGetResult>("cron.scratch.get", { id: jobId });
      if (isCurrent()) {
        setHeartbeatScratch(result.scratch?.content ?? "");
        publishCronState(cronState);
      }
    } catch (error) {
      if (isCurrent()) {
        cronState.cronError = formatUiError(error);
        publishCronState(cronState);
      }
    }
  }

  function resetEditor(createOpen: boolean) {
    clearHeartbeatScratch();
    routeSelection.target = null;
    // Retire discovery before resetting its editor's form.
    eventSource.reset();
    deliveryDirectory.retireEditor();
    cancelCronEdit(cron, context().agentSelection.state.selectedId);
    cron.cronCreateOpen = createOpen;
  }

  function openCreate(patch?: Partial<CronFormState>) {
    if (!canManageCron()) {
      return;
    }
    resetEditor(true);
    if (patch) {
      patchForm(patch);
      return;
    }
    publishCronState();
  }

  function cloneJob(job: CronJob) {
    if (!canManageCron()) {
      return;
    }
    clearHeartbeatScratch();
    routeSelection.target = null;
    // A clone is a prefilled create: the editor submits cron.add, not update.
    startCronClone(cron, job);
    cron.cronCreateOpen = true;
    deliveryDirectory.openEditor();
    publishCronState();
  }

  async function removeJob(job: CronJob) {
    const currentContext = context();
    const cronState = cron;
    const connectionScope = gateway.capture();
    const hadAdminAccess = canManageCron();
    const selectedJob =
      cronState.cronEditingJob?.id === job.id
        ? cronState.cronEditingJob
        : cronState.cronJobs.find(
            (entry) => entry.id === job.id && entry.updatedAtMs === job.updatedAtMs,
          );
    if (!connectionScope || !hadAdminAccess || !selectedJob) {
      return;
    }
    const selectedJobId = selectedJob.id;
    const selectedJobRevision = selectedJob.updatedAtMs;
    const selectedJobName = selectedJob.name;
    const confirmed = await showConfirmDialog({
      title: t("cron.actions.removeConfirmTitle", { name: selectedJobName }),
      message: t("cron.actions.removeConfirmMessage"),
      confirmLabel: t("cron.actions.remove"),
      danger: true,
    });
    const currentJob =
      cronState.cronEditingJob?.id === selectedJobId
        ? cronState.cronEditingJob
        : cronState.cronJobs.find((entry) => entry.id === selectedJobId);
    // Confirmation may outlive the job revision, access, connection, or page.
    if (
      !confirmed ||
      context() !== currentContext ||
      cron !== cronState ||
      !gateway.isCurrent(connectionScope) ||
      !canManageCron() ||
      !currentJob ||
      currentJob.updatedAtMs !== selectedJobRevision
    ) {
      return;
    }
    const editorGeneration = deliveryDirectory.generation;
    await runCronTask(async (current) => {
      const editorOwnedDiscovery = current.cronEditingJob?.id === selectedJobId;
      await removeCronJob(current, currentJob);
      // Rejected removals resolve with cronError. Only a confirmed editor exit
      // may retire discovery, preventing late directory errors on the overview.
      if (editorOwnedDiscovery && current.cronEditingJob?.id !== selectedJobId) {
        if (current === cron && routeSelection.target?.jobId === selectedJobId) {
          routeSelection.target = null;
        }
        deliveryDirectory.retireExitedEditor(current, connectionScope, editorGeneration);
      }
      // The overview must resume all-job history after removing its selected task.
      if (current.cronRunsScope === "job" && current.cronRunsJobId === null) {
        await loadCronRunsForJob(current, null);
      }
    });
  }

  function closePanel() {
    resetEditor(false);
    publishCronState();
    void runCronTask((cronState) => loadCronRunsForJob(cronState, null));
  }

  function submitForm(runNow = false) {
    // Synchronize the revision-bound catalog before validating a possibly replaced definition.
    eventSource.sync();
    const eventErrors = validateCronEventSelection(cron.cronForm, eventSource.view);
    if (hasCronFormErrors(eventErrors)) {
      // Catalog/schema feedback is derived from the current source in the view,
      // not retained on the form after discovery finishes or changes revision.
      cron.cronFieldErrors = validateCronForm(cron.cronForm);
      publishCronState();
      return;
    }
    const connectionScope = gateway.capture();
    const editorGeneration = deliveryDirectory.generation;
    runCronAdminTask(async (cronState) => {
      const editing = Boolean(cronState.cronEditingJob);
      const result = await addCronJob(cronState);
      if (!result.saved) {
        // Conflict recovery may replace the route even though saved is false.
        deliveryDirectory.reconcileRoute(cronState, connectionScope, editorGeneration);
        return;
      }
      // Only the current editor may affect discovery; other completion work
      // stays on the captured CronState after navigation.
      const stillEditing = editing || Boolean(cronState.cronEditingJob);
      deliveryDirectory.afterSave(cronState, connectionScope, editorGeneration, stillEditing);
      if (editing) {
        return;
      }
      if (runNow) {
        // Explicit create-and-run intent survives navigation while saving.
        await runCronJob(cronState, result.jobId, "force");
      }
      // Creating returns to the overview's all-job history.
      if (
        !cronState.cronEditingJob &&
        !cronState.cronCreateOpen &&
        cronState.cronRunsScope === "job"
      ) {
        await loadCronRunsForJob(cronState, null);
      }
    });
  }

  const actions = {
    onListTabChange: setListTab,
    onDetailTabChange: setDetailTab,
    onFormChange: patchForm,
    onRefresh: () => void refreshCron(),
    onSubmit: () => submitForm(),
    onSubmitRunNow: () => submitForm(true),
    onSelectJob: selectJob,
    onOpenCreate: openCreate,
    onClosePanel: closePanel,
    onClone: cloneJob,
    onToggle: (job: CronJob, enabled: boolean) => {
      const scope = gateway.capture();
      const editorGeneration = deliveryDirectory.generation;
      runCronAdminTask(async (cronState) => {
        await toggleCronJob(cronState, job, enabled);
        deliveryDirectory.reconcileRoute(cronState, scope, editorGeneration);
      });
    },
    onRun: (job: CronJob, mode?: "force" | "due") =>
      runCronAdminTask((cronState) => runCronJob(cronState, job.id, mode ?? "force")),
    onRemove: removeJob,
    onLoadMoreJobs: () =>
      void runCronTask((cronState) =>
        loadCronJobsPage(cronState, { append: true, tableFilters: true }),
      ),
    onJobsFiltersChange: updateJobsFilters,
    onJobsFiltersReset: () =>
      updateJobsFilters({
        cronJobsScheduleKindFilter: "all",
        cronJobsLastStatusFilter: "all",
        cronJobsTriggerFilter: "all",
        cronJobsSortBy: "nextRunAtMs",
        cronJobsSortDir: "asc",
      }),
    onLoadMoreRuns: () =>
      void runCronTask((cronState) => loadCronRuns(cronState, { append: true })),
    onRunsFiltersChange: (patch: Parameters<typeof updateCronRunsFilter>[1]) =>
      void runCronTask(async (cronState) => {
        updateCronRunsFilter(cronState, patch);
        if (patch.cronRunsRunId !== undefined && cronState.cronEditingJob) {
          routeSelection.select(cronState.cronEditingJob.id, patch.cronRunsRunId);
        }
        await loadCronRuns(cronState);
      }),
    onViewRunTranscript: (entry: CronRunLogEntry, trigger: HTMLButtonElement) =>
      void runTranscript.open(entry, trigger),
  };
  return {
    context,
    inventories: { agents, channels, runtimeConfig },
    cron: projection.read,
    canManageCron,
    cronModelSuggestions,
    modelSuggestionsError,
    listTab,
    detailTab,
    heartbeatScratch,
    actions,
    runTranscript,
    deliveryDirectory,
    eventSource,
    revision: projection.revision,
    publish,
    setRouteSearch,
    registerRun(this: void, element: HTMLElement, entry: () => CronRunLogEntry) {
      runRows.set(element, entry);
      afterRender();
      return () => runRows.delete(element);
    },
  };
}
