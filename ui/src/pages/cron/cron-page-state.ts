import { createSignal, onSettled } from "solid-js";
import { cronRunEntryMatchesLink } from "../../../../src/cron/run-link.js";
import type { CronJob, CronRunLogEntry } from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { hasOperatorReadAccess, readGatewayOperatorAccess } from "../../app/operator-access.ts";
import { showConfirmDialog } from "../../components/confirm-dialog.ts";
import { registerCronEnglish } from "../../i18n/locales/en-cron.ts";
import { watchAgentScope, watchSelectedAgent } from "../../lib/agents/index.ts";
import { createChannelCapability } from "../../lib/channels/index.ts";
import {
  hasCronFormErrors,
  normalizeCronFormState,
  validateCronForm,
} from "../../lib/cron/form.ts";
import {
  addCronJob,
  cancelCronEdit,
  createInitialCronState,
  invalidateCronMutation,
  invalidateCronRefresh,
  loadCronJobsPage,
  loadCronStatus,
  removeCronJob,
  runCronJob,
  startCronClone,
  startCronEdit,
  toggleCronJob,
  updateCronJobsFilter,
} from "../../lib/cron/index.ts";
import {
  hasCronInventoryEvents,
  isCronInventoryInvalidation,
} from "../../lib/cron/inventory-connection.ts";
import { loadCronRuns, loadCronRunsForJob, updateCronRunsFilter } from "../../lib/cron/runs.ts";
import type { CronFormState, CronState } from "../../lib/cron/types.ts";
import { isGatewayAvailable } from "../../lib/gateway-availability.ts";
import { createGatewayConnectionLifecycle } from "../../lib/gateway-connection-lifecycle.ts";
import { formatMissingOperatorReadScopeMessage } from "../../lib/gateway-errors.ts";
import { registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";
import { projectOwner, projectMutableSource } from "../../lib/reactive/projection.ts";
import { useVisiblePoll } from "../../lib/reactive/visible-poll.ts";
import { createCronPresentation } from "./cron-page-presentation.ts";
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
  const [listTab, setListTab] = createSignal<CronListTab>("tasks");
  const [detailTab, setDetailTab] = createSignal<CronDetailTab>("settings");
  let active = false;
  const cleanups: Array<() => void> = [];
  const gateway = createGatewayConnectionLifecycle({ client: null, phase: "stopped" });
  let boundContext: ApplicationContext | null = null;
  let gatewayAvailable = false;
  const projection = projectMutableSource(null, () => cron);
  const presentation = createCronPresentation({
    currentState: () => cron,
    readState: projection.read,
    connection: gateway,
    context,
    active: () => active,
    publish: publishCronState,
  });
  const agents = projectOwner(context().agents, (source) => source.state);
  const channels = projectOwner(
    context().acquireChannels(createChannelCapability),
    (source) => source.state,
  );
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
  const safetyRefresh = useVisiblePoll(600_000, () => ensureInitialData(true));
  const observeAgentScope = watchAgentScope((scopeId, intentChanged) => {
    if (!intentChanged) {
      // Hydration refines scope without replacing operator intent or drafts.
      cron.cronAgentId = scopeId;
      void refreshCron();
      void presentation.loadModels(cron);
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
    let location = currentContext.router.getState().location;
    cleanups.push(
      currentContext.router.subscribe((state) => {
        if (state.location !== location) {
          location = state.location;
          presentation.retire();
        }
      }),
    );
    const sourceChanged = boundContext !== null && boundContext.gateway !== currentContext.gateway;
    let first = boundContext === null || sourceChanged;
    boundContext = currentContext;
    agents.replaceSource(currentContext.agents);
    channels.replaceSource(currentContext.acquireChannels(createChannelCapability));
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
        presentation.retire();
        invalidateCronRefresh(cron);
        cron.client = snapshot.client;
        cron.connected = snapshot.phase === "connected";
        runTranscript.reconnect();
        if (!cron.cronEditingJob && !cron.cronCreateOpen) {
          routeSelection.requested = false;
        }
      }
      if (snapshot.phase === "connected" && !readGatewayOperatorAccess(snapshot).canAdmin) {
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
        if (presentation.modelRequest?.agentId !== agentId) {
          void presentation.loadModels(cron);
        }
      }),
      currentContext.gateway.subscribeEvents((event) => {
        if (
          active &&
          context() === currentContext &&
          (event.event === "cron" ||
            (hasCronInventoryEvents(currentContext.gateway.snapshot) &&
              isCronInventoryInvalidation(event, currentContext.gateway.snapshot)))
        ) {
          void refreshCron({
            coalesce: true,
            event: event.event === "cron" ? event.payload : undefined,
          });
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
      presentation.dispose();
      safetyRefresh.stop();
      cleanups.splice(0).forEach((stop) => stop());
      gateway.dispose();
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
    presentation.retire();
    presentation.resetModels();
    runTranscript.close();
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
    deliveryDirectory.retireEditor();
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
      void presentation.runTask(loadCronRuns);
    }
    if (forceRefresh || presentation.modelRequest?.state !== cron) {
      void presentation.loadModels(cron);
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
    presentation.retire();
    routeSearch = search;
    runTranscript.close();
    cron.cronError = null;
    cron.cronNotice = null;
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
      presentation.retire();
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
      void presentation.runTask((current) =>
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

  async function refreshCron(
    options: { coalesce?: boolean; event?: unknown; refresh?: boolean } = {},
  ) {
    const cronState = cron;
    if (!canRefreshCron(cronState) || !cronState.connected || !cronState.client) {
      return;
    }
    void presentation.runTask((current) => loadCronRuns(current, options));
    void context().acquireChannels(createChannelCapability).refresh(false);
    await Promise.all([
      presentation.read("status", (current) => loadCronStatus(current, options)),
      presentation.read("jobs", (current) =>
        loadCronJobsPage(current, {
          tableFilters: true,
          event: options.event,
          refresh: options.refresh,
        }),
      ),
    ]);
  }

  function updateJobsFilters(patch: Parameters<typeof updateCronJobsFilter>[1]) {
    void presentation.read("jobs", async (cronState) => {
      updateCronJobsFilter(cronState, patch);
      await loadCronJobsPage(cronState, { append: false, tableFilters: true });
    });
  }

  function toggle(job: CronJob, enabled: boolean): void {
    const view = presentation.capture();
    if (
      !presentation.isCurrent(view) ||
      !canManageCron() ||
      !cron.connected ||
      !cron.client ||
      cron.cronBusy
    ) {
      return;
    }
    const selected =
      cron.cronEditingJob?.id === job.id
        ? cron.cronEditingJob
        : cron.cronJobs.find((entry) => entry.id === job.id);
    if (!selected) {
      return;
    }
    const scope = gateway.capture();
    const editorGeneration = deliveryDirectory.generation;
    const pending = presentation.runTask(async (state) => {
      await toggleCronJob(state, selected, enabled);
      deliveryDirectory.reconcileRoute(state, scope, editorGeneration);
    });
    void presentation.mutate(view, pending, { id: selected.id, enabled });
  }

  function runCronAdminTask<T>(task: (cronState: CronState) => Promise<T>): void {
    // Recheck access at dispatch after possible reconnect or downgrade.
    if (!canManageCron()) {
      return;
    }
    void presentation.runTask(task);
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
    routeSelection.select(job.id, runId);
    pendingRunScroll = Boolean(runId);
    if (runId) {
      setDetailTab("history");
    }
    cron.cronCreateOpen = false;
    startCronEdit(cron, job);
    // Claim the run pane before awaiting to retire the previous job's history.
    void presentation.runTask((cronState) => loadCronRunsForJob(cronState, job.id, runId));
    deliveryDirectory.openEditor();
  }

  function resetEditor(createOpen: boolean) {
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
    routeSelection.target = null;
    // A clone is a prefilled create: the editor submits cron.add, not update.
    startCronClone(cron, job);
    cron.cronCreateOpen = true;
    deliveryDirectory.openEditor();
    publishCronState();
  }

  async function removeJob(job: CronJob) {
    const view = presentation.capture();
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
    if (!presentation.isCurrent(view) || !connectionScope || !hadAdminAccess || !selectedJob) {
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
    const pending = presentation.runTask(async (current) => {
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
    return presentation.mutate(view, pending);
  }

  function closePanel() {
    resetEditor(false);
    publishCronState();
    void presentation.runTask((cronState) => loadCronRunsForJob(cronState, null));
  }

  function submitForm(runNow = false): void {
    const view = presentation.capture();
    if (!presentation.isCurrent(view) || !canManageCron()) {
      return;
    }
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
    const pending = presentation.runTask(async (cronState) => {
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
    void presentation.mutate(view, pending);
  }

  const actions = {
    onListTabChange: setListTab,
    onDetailTabChange: setDetailTab,
    onFormChange: patchForm,
    onRefresh: () => void refreshCron({ refresh: true }),
    onSubmit: () => submitForm(),
    onSubmitRunNow: () => submitForm(true),
    onSelectJob: selectJob,
    onOpenCreate: openCreate,
    onClosePanel: closePanel,
    onClone: cloneJob,
    onToggle: (job: CronJob, enabled: boolean) => toggle(job, enabled),
    onRun: (job: CronJob, mode?: "force" | "due") =>
      runCronAdminTask((cronState) => runCronJob(cronState, job.id, mode ?? "force")),
    onRemove: (job: CronJob) => {
      const view = presentation.capture();
      return removeJob(job).catch((error: unknown) => presentation.reportError(view, error));
    },
    onLoadMoreJobs: () =>
      void presentation.read("jobs", (cronState) =>
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
      void presentation.runTask((cronState) => loadCronRuns(cronState, { append: true })),
    onRunsFiltersChange: (patch: Parameters<typeof updateCronRunsFilter>[1]) =>
      void presentation.runTask(async (cronState) => {
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
    saving: presentation.saving,
    toggleSavingJobId: presentation.toggleSavingJobId,
    getActionRetired: () => presentation.retired,
    reads: presentation.reads,
    canManageCron,
    cronModelSuggestions: presentation.modelSuggestions,
    listTab,
    detailTab,
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
