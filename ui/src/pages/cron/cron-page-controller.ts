import type { CronJob, CronScratchGetResult } from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { readGatewayOperatorAccess } from "../../app/operator-access.ts";
import { showConfirmDialog } from "../../components/confirm-dialog.ts";
import { registerCronEnglish } from "../../i18n/locales/en-cron.ts";
import { watchAgentScope, watchSelectedAgent } from "../../lib/agents/index.ts";
import { buildQualifiedChatModelValue } from "../../lib/chat/model-ref.ts";
import {
  addCronJob,
  cancelCronEdit,
  createInitialCronState,
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
import { loadCronRuns, loadMoreCronRuns, updateCronRunsFilter } from "../../lib/cron/runs.ts";
import type { CronFormState, CronState } from "../../lib/cron/types.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { isGatewayAvailable } from "../../lib/gateway-availability.ts";
import { createGatewayConnectionLifecycle } from "../../lib/gateway-connection-lifecycle.ts";
import { modelCatalogEventInvalidation } from "../../lib/model-catalog-cache.ts";
import { loadModelCatalog, modelCatalogRefreshError } from "../../lib/model-catalog-store.ts";
import { registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";
import {
  DeliveryConversationsController,
  invalidateStaleDeliveryRoute,
  requiresDirectoryReload,
} from "./delivery-conversations.ts";
import { resolveCronRouteData } from "./route-model.ts";
import { CronRunTranscript } from "./run-transcript.tsx";
import type { CronDetailTab, CronListTab, CronProps } from "./view-types.ts";

registerEnglishCatalog(registerCronEnglish);

/** Renderer lifecycle only; cron's domain state remains synchronously mutable. */
export class CronPageController {
  routeSearch = "";
  cron = createInitialCronState();
  cronModelSuggestions: string[] = [];
  modelSuggestionsError: string | null = null;
  listTab: CronListTab = "tasks";
  detailTab: CronDetailTab = "settings";
  heartbeatScratch = "";
  private active = true;
  private readonly cleanups: Array<() => void> = [];
  private readonly gateway = createGatewayConnectionLifecycle({ client: null, phase: "stopped" });
  private boundContext: ApplicationContext | null = null;
  private gatewayAvailable = false;

  constructor(
    public context: ApplicationContext,
    readonly host: HTMLElement,
    private readonly notify: () => void,
  ) {
    this.runTranscript = new CronRunTranscript(
      this.host,
      () => this.publish(),
      () => {
        const scope = this.gateway.capture();
        const cron = this.cron;
        return scope
          ? {
              client: scope.client,
              isCurrent: () => this.gateway.isCurrent(scope) && this.cron === cron,
            }
          : null;
      },
    );

    this.bindContext();
  }

  readonly runTranscript: CronRunTranscript;
  private pendingRouteData: ReturnType<typeof resolveCronRouteData> | null = null;
  private routeJobRequested = false;
  highlightedRunId: string | null = null;
  private pendingRunScroll = false;
  private modelSuggestionsRequest: { state: CronState; agentId: string } | null = null;
  readonly deliveryDirectory = new DeliveryConversationsController({
    currentCronState: () => this.cron,
    canManage: () => this.canManageCron,
    captureConnection: () => this.gateway.capture(),
    isCurrentConnection: (scope) => this.gateway.isCurrent(scope),
    notify: (cronState) => this.publishCronState(cronState),
  });
  private heartbeatScratchRequest = 0;
  private pageHidden = document.visibilityState === "hidden";
  private readonly observeAgentScope = watchAgentScope((scopeId, intentChanged) => {
    if (!intentChanged) {
      // Hydration refines scope without replacing operator intent or drafts.
      this.cron.cronAgentId = scopeId;
      void this.refreshCron();
      void this.loadModelSuggestions(this.cron);
      if (
        (this.cron.cronEditingJob || this.cron.cronCreateOpen) &&
        !this.cron.cronForm.agentId.trim()
      ) {
        void this.deliveryDirectory.load();
      }
      this.publish();
      return;
    }
    this.pendingRouteData = null;
    // Replacing the owner retires results from the previous agent scope.
    this.resetGatewayState(this.context.gateway.snapshot);
    this.cron.cronAgentId = scopeId;
    this.listTab = "tasks";
    this.detailTab = "settings";
    this.ensureInitialData();
    this.publish();
  });
  get agentsList() {
    return this.context.agents.state.agentsList;
  }

  get canManageCron(): boolean {
    return readGatewayOperatorAccess(this.context.gateway.snapshot).canAdmin;
  }

  private bindContext() {
    this.cleanups.splice(0).forEach((stop) => stop());
    const context = this.context;
    const sourceChanged =
      this.boundContext !== null && this.boundContext.gateway !== context.gateway;
    let first = this.boundContext === null || sourceChanged;
    this.boundContext = context;
    if (sourceChanged) {
      this.gateway.invalidate();
    }
    const applySnapshot = () => {
      if (!this.active || this.context !== context) {
        return;
      }
      const snapshot = context.gateway.snapshot;
      const previousConnected = this.gateway.capture() !== null;
      const changed = this.gateway.transition(snapshot);
      const nextAvailable = isGatewayAvailable(snapshot);
      if (first || changed) {
        this.resetGatewayState(snapshot);
      } else if (!readGatewayOperatorAccess(snapshot).canAdmin) {
        this.clearHeartbeatScratch();
        this.deliveryDirectory.clear();
      }
      if (snapshot.phase === "connected" && (first || changed)) {
        this.ensureInitialData();
      } else if (!first && !this.gatewayAvailable && nextAvailable && previousConnected) {
        this.ensureInitialData(true);
      }
      first = false;
      this.gatewayAvailable = nextAvailable;
      this.publish();
    };
    this.cleanups.push(context.gateway.subscribe(applySnapshot));
    applySnapshot();
    this.cleanups.push(
      context.agents.subscribe(() => this.publish()),
      context.channels.subscribe(() => this.publish()),
      context.runtimeConfig.subscribe(() => this.publish()),
      this.observeAgentScope(context.agentSelection),
      watchSelectedAgent(context.agentSelection, (agentId) => {
        if (this.modelSuggestionsRequest?.agentId !== agentId) {
          void this.loadModelSuggestions(this.cron);
        }
      }),
      context.gateway.subscribeEvents((event) => {
        if (this.active && this.context === context) {
          if (event.event === "cron") {
            void this.refreshCron({ coalesce: true });
          } else if (modelCatalogEventInvalidation(event)) {
            void this.loadModelSuggestions(this.cron);
          }
        }
      }),
    );
  }

  private readonly onActivation = () => {
    const hidden = document.visibilityState === "hidden";
    const resumed = this.pageHidden && !hidden;
    this.pageHidden = hidden;
    if (resumed) {
      this.ensureInitialData(true);
    }
  };

  activate() {
    document.addEventListener("visibilitychange", this.onActivation);
    globalThis.addEventListener("focus", this.onActivation);
  }

  dispose() {
    this.active = false;
    document.removeEventListener("visibilitychange", this.onActivation);
    globalThis.removeEventListener("focus", this.onActivation);
    this.cleanups.splice(0).forEach((stop) => stop());
    this.gateway.dispose();
    this.resetGatewayState({ ...this.context.gateway.snapshot, client: null, phase: "stopped" });
  }

  publish() {
    if (!this.active) {
      return;
    }
    if (this.boundContext !== this.context) {
      this.bindContext();
    }
    this.preparePanel();
    this.notify();
  }

  private resetGatewayState(snapshot: ApplicationContext["gateway"]["snapshot"]) {
    this.runTranscript.close();
    this.clearHeartbeatScratch();
    invalidateCronRefresh(this.cron);
    const connected = snapshot.phase === "connected";
    const cron = createInitialCronState({
      client: snapshot.client,
      connected,
    });
    cron.canRefresh = () => this.canRefreshCron(cron);
    this.cron = cron;
    const routeData = resolveCronRouteData(this.routeSearch);
    cron.cronSessionFilter = routeData.session;
    this.routeJobRequested = false;
    this.pageHidden = document.visibilityState === "hidden";
    this.cron.cronAgentId = this.context.agentSelection.state.scopeId;
    this.cronModelSuggestions = [];
    this.deliveryDirectory.retireEditor();
    this.modelSuggestionsError = null;
    this.modelSuggestionsRequest = null;
  }

  private canRefreshCron(cron: CronState = this.cron) {
    return (
      this.active &&
      this.host.isConnected &&
      this.cron === cron &&
      isGatewayAvailable(this.context.gateway.snapshot) &&
      document.visibilityState !== "hidden"
    );
  }

  private ensureInitialData(forceRefresh = false) {
    if (!this.canRefreshCron() || !this.cron.connected || !this.cron.client) {
      return;
    }
    if (!this.agentsList && !this.context.agents.state.agentsLoading) {
      void this.context.agents.ensureList();
    }
    if (forceRefresh || (!this.cron.cronStatus && !this.cron.cronLoading)) {
      void this.refreshCron({ coalesce: true });
    } else if (!this.cron.cronRuns.length && !this.cron.cronRunsLoadingMore) {
      void this.loadRuns();
    }
    if (forceRefresh || this.modelSuggestionsRequest?.state !== this.cron) {
      void this.loadModelSuggestions(this.cron);
    }
  }

  private publishCronState(cronState: CronState = this.cron) {
    if (this.cron === cronState) {
      this.publish();
    }
  }

  private lastPanelKey: string | null = null;

  setRouteSearch(search: string) {
    if (search === this.routeSearch) {
      return;
    }
    this.routeSearch = search;
    this.runTranscript.close();
    this.cron.cronError = null;
    const routeData = resolveCronRouteData(search);
    if (JSON.stringify(this.cron.cronSessionFilter) !== JSON.stringify(routeData.session)) {
      this.resetGatewayState(this.context.gateway.snapshot);
      this.ensureInitialData();
    }
    this.listTab = "tasks";
    this.detailTab = "settings";
    this.pendingRouteData = routeData.jobId || routeData.session ? routeData : null;
    this.routeJobRequested = false;
    this.highlightedRunId = null;
    this.pendingRunScroll = false;
    this.publish();
  }

  private preparePanel() {
    // Retire transcript requests before displaying another panel target.
    const editingJobId = this.cron.cronEditingJob?.id ?? null;
    const mode = editingJobId ? "job" : this.cron.cronCreateOpen ? "create" : "overview";
    const panelKey = `${mode}:${editingJobId ?? ""}`;
    if (panelKey !== this.lastPanelKey) {
      this.lastPanelKey = panelKey;
      this.runTranscript.close();
      this.detailTab = editingJobId && this.highlightedRunId ? "history" : "settings";
      const scroller = this.host.closest(".content");
      if (scroller instanceof HTMLElement && typeof scroller.scrollTo === "function") {
        scroller.scrollTo({ top: 0 });
      }
    }
  }

  afterRender() {
    const routeData = this.pendingRouteData;
    const client = this.cron.client;
    if (routeData?.session && this.cron.cronJobsSnapshotRevision && !this.cron.cronLoading) {
      this.pendingRouteData = null;
      const [job] = this.cron.cronJobs;
      if (this.cron.cronJobsTotal === 1 && job) {
        this.selectJob(job);
      }
    }
    if (routeData?.jobId && client && this.cron.connected && !this.routeJobRequested) {
      this.routeJobRequested = true;
      void this.runCronTask(async (current) => {
        const isCurrent = () =>
          this.active &&
          this.host.isConnected &&
          this.cron === current &&
          this.pendingRouteData === routeData;
        try {
          // Links identify an exact job; a filtered inventory page cannot resolve them.
          const job = await client.request<CronJob>("cron.get", { id: routeData.jobId });
          if (isCurrent()) {
            this.selectJob(job, routeData.runId);
          }
        } catch (error) {
          if (isCurrent()) {
            this.pendingRouteData = null;
            current.cronError = formatUiError(error);
          }
        }
      });
    }
    if (this.pendingRunScroll) {
      const run = this.host.querySelector<HTMLElement>(".cron-run-entry--highlighted");
      if (run) {
        run.scrollIntoView?.({ block: "nearest" });
        this.pendingRunScroll = false;
      }
    }
  }

  private async refreshCron(options: { coalesce?: boolean } = {}) {
    const cronState = this.cron;
    if (!this.canRefreshCron(cronState) || !cronState.connected || !cronState.client) {
      return;
    }
    void this.loadRuns(options.coalesce);
    void this.context.channels.refresh(false);
    await Promise.all([
      this.runCronTask((current) => loadCronStatus(current, options)),
      this.runCronTask((current) => loadCronJobsPage(current, { tableFilters: true })),
    ]);
  }

  private loadRuns(coalesce = false) {
    return this.runCronTask((cronState) => loadCronRuns(cronState, { coalesce }));
  }

  private updateJobsFilters(patch: Parameters<typeof updateCronJobsFilter>[1]) {
    void this.runCronTask(async (cronState) => {
      updateCronJobsFilter(cronState, patch);
      await loadCronJobsPage(cronState, { append: false, tableFilters: true });
    });
  }

  private async loadModelSuggestions(cronState: CronState) {
    const client = cronState.client;
    const agentId = this.context.agentSelection.state.selectedId;
    // Last-good suggestions belong to one agent, including when its successor has no catalog.
    if (this.modelSuggestionsRequest?.agentId !== agentId) {
      this.modelSuggestionsRequest = null;
      this.cronModelSuggestions = [];
      this.modelSuggestionsError = null;
      this.publishCronState(cronState);
    }
    if (!client || !agentId || !isGatewayAvailable(this.context.gateway.snapshot)) {
      return;
    }
    const request = { state: cronState, agentId };
    this.modelSuggestionsRequest = request;
    // Only the latest catalog request may publish rows or errors.
    const isCurrent = () =>
      this.cron === cronState &&
      this.modelSuggestionsRequest === request &&
      this.context.agentSelection.state.selectedId === agentId;
    try {
      const result = await loadModelCatalog(client, { agentId });
      if (isCurrent()) {
        this.cronModelSuggestions = result.models
          .filter((entry) => entry.manualSelectionAllowed !== false)
          .map((entry) => buildQualifiedChatModelValue(entry.id, entry.provider));
        this.modelSuggestionsError = modelCatalogRefreshError(result);
        this.publishCronState(cronState);
      }
    } catch (error) {
      if (isCurrent()) {
        this.modelSuggestionsError = formatUiError(error);
        this.publishCronState(cronState);
      }
    }
  }

  private async runCronTask<T>(task: (cronState: CronState) => Promise<T>): Promise<T> {
    const cronState = this.cron;
    try {
      const result = task(cronState);
      this.publishCronState(cronState);
      return await result;
    } finally {
      this.publishCronState(cronState);
    }
  }

  private runCronAdminTask<T>(task: (cronState: CronState) => Promise<T>): void {
    // Recheck access at dispatch after possible reconnect or downgrade.
    if (!this.canManageCron) {
      return;
    }
    void this.runCronTask(task);
  }

  patchForm(patch: Partial<CronFormState>) {
    if (!this.canManageCron) {
      return;
    }
    const current = this.cron.cronForm;
    const resolvedPatch = invalidateStaleDeliveryRoute(current, patch);
    const next = normalizeCronFormState({ ...this.cron.cronForm, ...resolvedPatch }, resolvedPatch);
    this.cron.cronForm = next;
    this.cron.cronFieldErrors = validateCronForm(this.cron.cronForm);
    if (requiresDirectoryReload(current, next)) {
      void this.deliveryDirectory.load();
    }
    this.publishCronState();
  }

  selectJob(job: CronJob, runId: string | null = null) {
    this.clearHeartbeatScratch();
    this.pendingRouteData = null;
    this.highlightedRunId = runId;
    this.pendingRunScroll = Boolean(runId);
    if (runId) {
      this.detailTab = "history";
    }
    this.cron.cronCreateOpen = false;
    startCronEdit(this.cron, job);
    this.deliveryDirectory.openEditor();
    this.publishCronState();
    if (job.payload?.kind === "heartbeat") {
      void this.loadHeartbeatScratch(this.cron, job.id, this.heartbeatScratchRequest);
    }
    void this.runCronTask(async (cronState) => {
      // Claim the run pane before awaiting to retire the previous job's history.
      await this.refreshRunsScope(cronState, job.id);
    });
  }

  private refreshRunsScope(cronState: CronState, jobId: string | null) {
    updateCronRunsFilter(cronState, { cronRunsScope: jobId === null ? "all" : "job" });
    cronState.cronRunsJobId = jobId;
    return loadCronRuns(cronState);
  }

  private clearHeartbeatScratch() {
    this.heartbeatScratchRequest += 1;
    this.heartbeatScratch = "";
  }

  private async loadHeartbeatScratch(cronState: CronState, jobId: string, requestId: number) {
    const client = cronState.client;
    if (!this.canManageCron || !client || !cronState.connected) {
      return;
    }
    const connectionScope = this.gateway.capture();
    if (!connectionScope) {
      return;
    }
    // Revalidate scratch access, connection, and selection after the request.
    const isCurrent = () =>
      this.cron === cronState &&
      this.heartbeatScratchRequest === requestId &&
      this.gateway.isCurrent(connectionScope) &&
      this.canManageCron &&
      cronState.cronEditingJob?.id === jobId &&
      cronState.cronForm.payloadKind === "heartbeat";
    try {
      const result = await client.request<CronScratchGetResult>("cron.scratch.get", { id: jobId });
      if (isCurrent()) {
        this.heartbeatScratch = result.scratch?.content ?? "";
        this.publishCronState(cronState);
      }
    } catch (error) {
      if (isCurrent()) {
        cronState.cronError = formatUiError(error);
        this.publishCronState(cronState);
      }
    }
  }

  private resetEditor(createOpen: boolean) {
    this.clearHeartbeatScratch();
    this.pendingRouteData = null;
    // Retire discovery before resetting its editor's form.
    this.deliveryDirectory.retireEditor();
    cancelCronEdit(this.cron, this.context.agentSelection.state.selectedId);
    this.cron.cronCreateOpen = createOpen;
  }

  private openCreate(patch?: Partial<CronFormState>) {
    if (!this.canManageCron) {
      return;
    }
    this.resetEditor(true);
    if (patch) {
      this.patchForm(patch);
      return;
    }
    this.publishCronState();
  }

  private cloneJob(job: CronJob) {
    if (!this.canManageCron) {
      return;
    }
    this.clearHeartbeatScratch();
    this.pendingRouteData = null;
    // A clone is a prefilled create: the editor submits cron.add, not update.
    startCronClone(this.cron, job);
    this.cron.cronCreateOpen = true;
    this.deliveryDirectory.openEditor();
    this.publishCronState();
  }

  async removeJob(job: CronJob) {
    const context = this.context;
    const cronState = this.cron;
    const connectionScope = this.gateway.capture();
    const hadAdminAccess = this.canManageCron;
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
      this.context !== context ||
      this.cron !== cronState ||
      !this.gateway.isCurrent(connectionScope) ||
      !this.canManageCron ||
      !currentJob ||
      currentJob.updatedAtMs !== selectedJobRevision
    ) {
      return;
    }
    const editorGeneration = this.deliveryDirectory.generation;
    await this.runCronTask(async (current) => {
      const editorOwnedDiscovery = current.cronEditingJob?.id === selectedJobId;
      await removeCronJob(current, currentJob);
      // Rejected removals resolve with cronError. Only a confirmed editor exit
      // may retire discovery, preventing late directory errors on the overview.
      if (editorOwnedDiscovery && current.cronEditingJob?.id !== selectedJobId) {
        this.deliveryDirectory.retireExitedEditor(current, connectionScope, editorGeneration);
      }
      // The overview must resume all-job history after removing its selected task.
      if (current.cronRunsScope === "job" && current.cronRunsJobId === null) {
        await this.refreshRunsScope(current, null);
      }
    });
  }

  closePanel() {
    this.resetEditor(false);
    this.publishCronState();
    void this.runCronTask(async (cronState) => {
      await this.refreshRunsScope(cronState, null);
    });
  }

  submitForm(runNow = false) {
    const connectionScope = this.gateway.capture();
    const editorGeneration = this.deliveryDirectory.generation;
    this.runCronAdminTask(async (cronState) => {
      const editing = Boolean(cronState.cronEditingJob);
      const result = await addCronJob(cronState);
      if (!result.saved) {
        // Conflict recovery may replace the route even though saved is false.
        this.deliveryDirectory.reconcileRoute(cronState, connectionScope, editorGeneration);
        return;
      }
      // Only the current editor may affect discovery; other completion work
      // stays on the captured CronState after navigation.
      const stillEditing = editing || Boolean(cronState.cronEditingJob);
      this.deliveryDirectory.afterSave(cronState, connectionScope, editorGeneration, stillEditing);
      if (stillEditing) {
        return;
      }
      if (runNow && result.jobId) {
        // Explicit create-and-run intent survives navigation while saving.
        await runCronJob(cronState, result.jobId, "force");
      }
      cronState.cronCreateOpen = false;
      // Creating returns to the overview's all-job history.
      if (cronState.cronRunsScope === "job") {
        await this.refreshRunsScope(cronState, null);
      }
    });
  }

  get actions(): Pick<CronProps, Extract<keyof CronProps, `on${string}`>> {
    return {
      onListTabChange: (tab) => {
        this.listTab = tab;
        this.publish();
      },
      onDetailTabChange: (tab) => {
        this.detailTab = tab;
        this.publish();
      },
      onFormChange: (patch) => this.patchForm(patch),
      onRefresh: () => void this.refreshCron(),
      onSubmit: () => this.submitForm(),
      onSubmitRunNow: () => this.submitForm(true),
      onSelectJob: (job) => this.selectJob(job),
      onOpenCreate: (patch) => this.openCreate(patch),
      onClosePanel: () => this.closePanel(),
      onClone: (job) => this.cloneJob(job),
      onToggle: (job, enabled) =>
        this.runCronAdminTask((cronState) => toggleCronJob(cronState, job, enabled)),
      onRun: (job, mode) =>
        this.runCronAdminTask((cronState) => runCronJob(cronState, job.id, mode ?? "force")),
      onRemove: (job) => void this.removeJob(job),
      onLoadMoreJobs: () =>
        void this.runCronTask((cronState) =>
          loadCronJobsPage(cronState, { append: true, tableFilters: true }),
        ),
      onJobsFiltersChange: (patch) => this.updateJobsFilters(patch),
      onJobsFiltersReset: () =>
        this.updateJobsFilters({
          cronJobsScheduleKindFilter: "all",
          cronJobsLastStatusFilter: "all",
          cronJobsTriggerFilter: "all",
          cronJobsSortBy: "nextRunAtMs",
          cronJobsSortDir: "asc",
        }),
      onLoadMoreRuns: () => void this.runCronTask((cronState) => loadMoreCronRuns(cronState)),
      onRunsFiltersChange: (patch) =>
        void this.runCronTask(async (cronState) => {
          updateCronRunsFilter(cronState, patch);
          await loadCronRuns(cronState);
        }),
      onViewRunTranscript: (entry, trigger) => void this.runTranscript.open(entry, trigger),
    };
  }
}
