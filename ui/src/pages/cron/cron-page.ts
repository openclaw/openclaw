import { consume } from "@lit/context";
import { html, LitElement } from "lit";
import { state } from "lit/decorators.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { AgentsListResult, CronJob } from "../../api/types.ts";
import { subtitleForRoute, titleForRoute } from "../../app-navigation.ts";
import { applicationContext, type ApplicationContext } from "../../app/context.ts";
import { renderSettingsWorkspace } from "../../components/settings-workspace.ts";
import { currentConfigObject } from "../../lib/config/index.ts";
import {
  addCronJob,
  cancelCronEdit,
  createInitialCronState,
  DEFAULT_CRON_FORM,
  getCronJobPayload,
  getVisibleCronJobs,
  hasCronFormErrors,
  loadCronJobsPage,
  loadCronModelSuggestions,
  loadCronRuns,
  loadCronStatus,
  loadMoreCronRuns,
  normalizeCronFormState,
  removeCronJob,
  resolveConfiguredCronModelSuggestions,
  runCronJob,
  startCronClone,
  startCronEdit,
  toggleCronJob,
  updateCronJobsFilter,
  updateCronRunsFilter,
  validateCronForm,
  type CronModelSuggestionsState,
  type CronState,
} from "../../lib/cron/index.ts";
import { searchForSession } from "../../lib/sessions/index.ts";
import { sortUniqueStrings } from "../../lib/string-coerce.ts";
import { createDefaultDraft, draftToCronFormPatch, renderCronQuickCreate } from "./quick-create.ts";
import type { CronQuickCreateDraft, CronQuickCreateStep } from "./quick-create.ts";
import { renderCron } from "./view.ts";

const THINKING_SUGGESTIONS = ["off", "minimal", "low", "medium", "high"];
const TIMEZONE_SUGGESTIONS = [
  "UTC",
  "America/Los_Angeles",
  "America/Denver",
  "America/Chicago",
  "America/New_York",
  "Europe/London",
  "Europe/Berlin",
  "Asia/Tokyo",
];

function unique(values: string[]): string[] {
  return sortUniqueStrings(values.map((value) => value.trim()).filter(Boolean));
}

export class CronPage extends LitElement {
  createRenderRoot() {
    return this;
  }

  @consume({ context: applicationContext, subscribe: false })
  private context!: ApplicationContext;

  @state() private cron = createInitialCronState();
  @state() private agentsList: AgentsListResult | null = null;
  @state() private cronModelSuggestions: string[] = [];
  @state() private quickCreateOpen = false;
  @state() private quickCreateStep: CronQuickCreateStep = "what";
  @state() private quickCreateDraft: CronQuickCreateDraft | null = null;

  private stopGatewaySubscription?: () => void;
  private stopGatewayEvents?: () => void;
  private stopAgentsSubscription?: () => void;
  private stopChannelsSubscription?: () => void;
  private stopConfigSubscription?: () => void;
  private modelSuggestionsClient: GatewayBrowserClient | null = null;

  override connectedCallback() {
    super.connectedCallback();
    this.syncGatewayState();
    this.syncAgentsState();
    this.stopGatewaySubscription = this.context.gateway.subscribe(() => {
      this.syncGatewayState();
      this.ensureInitialData();
    });
    this.stopGatewayEvents = this.context.gateway.subscribeEvents((event) => {
      if (event.event === "cron") {
        void this.refreshCron({ tableFilters: true });
      }
    });
    this.stopAgentsSubscription = this.context.agents.subscribe(() => {
      this.syncAgentsState();
      this.requestUpdate();
    });
    this.stopChannelsSubscription = this.context.channels.subscribe(() => this.requestUpdate());
    this.stopConfigSubscription = this.context.runtimeConfig.subscribe(() => this.requestUpdate());
    this.ensureInitialData();
  }

  override disconnectedCallback() {
    this.stopGatewaySubscription?.();
    this.stopGatewaySubscription = undefined;
    this.stopGatewayEvents?.();
    this.stopGatewayEvents = undefined;
    this.stopAgentsSubscription?.();
    this.stopAgentsSubscription = undefined;
    this.stopChannelsSubscription?.();
    this.stopChannelsSubscription = undefined;
    this.stopConfigSubscription?.();
    this.stopConfigSubscription = undefined;
    super.disconnectedCallback();
  }

  private syncGatewayState() {
    const gateway = this.context.gateway.snapshot;
    if (this.cron.client !== gateway.client) {
      this.cron = createInitialCronState(gateway);
      this.cronModelSuggestions = [];
      this.modelSuggestionsClient = null;
      return;
    }
    if (this.cron.connected === gateway.connected) {
      return;
    }
    this.cron.connected = gateway.connected;
    this.requestUpdate();
  }

  private syncAgentsState() {
    this.agentsList = this.context.agents.state.agentsList;
  }

  private ensureInitialData() {
    if (!this.cron.connected || !this.cron.client) {
      return;
    }
    if (!this.agentsList && !this.context.agents.state.agentsLoading) {
      void this.context.agents.ensureList();
    }
    if (!this.cron.cronStatus && !this.cron.cronLoading) {
      void this.refreshCron({ tableFilters: true });
    } else if (!this.cron.cronRuns.length && !this.cron.cronRunsLoadingMore) {
      void this.loadRuns(this.cron.cronRunsScope === "all" ? null : this.cron.cronRunsJobId);
    }
    if (this.modelSuggestionsClient !== this.cron.client) {
      this.modelSuggestionsClient = this.cron.client;
      void this.loadModelSuggestions();
    }
  }

  private requestCronUpdate(state: CronState = this.cron) {
    if (this.cron === state) {
      this.requestUpdate();
    }
  }

  private async refreshCron(options: { tableFilters: boolean }) {
    const state = this.cron;
    if (!state.connected || !state.client) {
      return;
    }
    const activeCronJobId = state.cronRunsScope === "job" ? state.cronRunsJobId : null;
    void this.loadRuns(activeCronJobId);
    void this.context.channels.refresh(false);
    await Promise.all([
      this.runCronTask((current) => loadCronStatus(current)),
      this.runCronTask((current) =>
        loadCronJobsPage(current, { tableFilters: options.tableFilters }),
      ),
    ]);
  }

  private loadRuns(jobId: string | null) {
    return this.runCronTask((state) => loadCronRuns(state, jobId));
  }

  private async loadModelSuggestions() {
    const state: CronModelSuggestionsState = {
      client: this.cron.client,
      connected: this.cron.connected,
      cronModelSuggestions: this.cronModelSuggestions,
    };
    await loadCronModelSuggestions(state);
    if (state.client === this.cron.client) {
      this.cronModelSuggestions = state.cronModelSuggestions;
    }
  }

  private async runCronTask<T>(task: (state: CronState) => Promise<T>): Promise<T> {
    const state = this.cron;
    try {
      const result = task(state);
      this.requestCronUpdate(state);
      return await result;
    } finally {
      this.requestCronUpdate(state);
    }
  }

  private openQuickCreate() {
    this.quickCreateOpen = true;
    this.quickCreateStep = "what";
    this.quickCreateDraft = createDefaultDraft();
  }

  private closeQuickCreate() {
    this.quickCreateOpen = false;
  }

  private draftToForm() {
    const draft = this.quickCreateDraft ?? createDefaultDraft();
    this.cron.cronEditingJobId = null;
    this.cron.cronForm = normalizeCronFormState({
      ...DEFAULT_CRON_FORM,
      ...draftToCronFormPatch(draft),
    });
    this.cron.cronFieldErrors = validateCronForm(this.cron.cronForm);
    this.requestCronUpdate();
  }

  private async createFromQuickCreate() {
    this.draftToForm();
    const saved = await this.runCronTask((state) => addCronJob(state));
    if (saved) {
      this.quickCreateOpen = false;
      this.quickCreateStep = "what";
      this.quickCreateDraft = null;
    }
  }

  private suggestions() {
    const channels = this.context.channels.state;
    const configValue = currentConfigObject(this.context.runtimeConfig.state);
    const channel = this.cron.cronForm.deliveryChannel.trim() || "last";
    const agentSuggestions = unique([
      ...(this.agentsList?.agents.map((entry) => entry.id.trim()) ?? []),
      ...this.cron.cronJobs.map((job) =>
        typeof job.agentId === "string" ? job.agentId.trim() : "",
      ),
    ]);
    const modelSuggestions = unique([
      ...this.cronModelSuggestions,
      ...resolveConfiguredCronModelSuggestions(configValue),
      ...this.cron.cronJobs.map((job) => {
        const payload = getCronJobPayload(job);
        return payload?.kind === "agentTurn" && typeof payload.model === "string"
          ? payload.model.trim()
          : "";
      }),
    ]);
    const jobTargets = this.cron.cronJobs
      .map((job) => (typeof job.delivery?.to === "string" ? job.delivery.to.trim() : ""))
      .filter(Boolean);
    const accountTargets = (
      channel === "last"
        ? Object.values(channels.channelsSnapshot?.channelAccounts ?? {}).flat()
        : (channels.channelsSnapshot?.channelAccounts?.[channel] ?? [])
    )
      .flatMap((account) => [account.accountId, account.name])
      .filter((value): value is string => typeof value === "string")
      .map((value) => value.trim())
      .filter(Boolean);
    const deliveryTargets = unique([...jobTargets, ...accountTargets]);
    return {
      agentSuggestions,
      modelSuggestions,
      accountTargets,
      deliveryToSuggestions:
        this.cron.cronForm.deliveryMode === "webhook"
          ? deliveryTargets.filter((value) => /^https?:\/\//i.test(value))
          : deliveryTargets,
    };
  }

  private editJob(job: CronJob) {
    this.cron.cronFormCollapsed = false;
    startCronEdit(this.cron, job);
    this.requestCronUpdate();
  }

  private cloneJob(job: CronJob) {
    this.cron.cronFormCollapsed = false;
    startCronClone(this.cron, job);
    this.requestCronUpdate();
  }

  override render() {
    const channels = this.context.channels.state;
    const suggestions = this.suggestions();
    return html`
      <section class="content-header">
        <div>
          <div class="page-title">${titleForRoute("cron")}</div>
          <div class="page-sub">${subtitleForRoute("cron")}</div>
        </div>
      </section>
      ${renderSettingsWorkspace(
        this.context.basePath,
        html`
          ${renderCronQuickCreate({
            open: this.quickCreateOpen,
            step: this.quickCreateStep,
            draft: this.quickCreateDraft ?? createDefaultDraft(),
            onCancel: () => this.closeQuickCreate(),
            onStepChange: (step) => (this.quickCreateStep = step),
            onDraftChange: (patch) => {
              this.quickCreateDraft = {
                ...(this.quickCreateDraft ?? createDefaultDraft()),
                ...patch,
              };
            },
            onCreate: () => void this.createFromQuickCreate(),
            onAdvancedCreate: () => {
              this.draftToForm();
              this.quickCreateOpen = false;
              this.quickCreateStep = "what";
              this.quickCreateDraft = null;
              this.cron.cronFormCollapsed = false;
              this.requestCronUpdate();
            },
          })}
          ${renderCron({
            basePath: this.context.basePath,
            loading: this.cron.cronLoading,
            status: this.cron.cronStatus,
            jobs: getVisibleCronJobs(this.cron),
            jobsLoadingMore: this.cron.cronJobsLoadingMore,
            jobsTotal: this.cron.cronJobsTotal,
            jobsHasMore: this.cron.cronJobsHasMore,
            jobsQuery: this.cron.cronJobsQuery,
            jobsEnabledFilter: this.cron.cronJobsEnabledFilter,
            jobsScheduleKindFilter: this.cron.cronJobsScheduleKindFilter,
            jobsLastStatusFilter: this.cron.cronJobsLastStatusFilter,
            jobsSortBy: this.cron.cronJobsSortBy,
            jobsSortDir: this.cron.cronJobsSortDir,
            editingJobId: this.cron.cronEditingJobId,
            error: this.cron.cronError,
            busy: this.cron.cronBusy,
            form: this.cron.cronForm,
            cronFormCollapsed: this.cron.cronFormCollapsed,
            channels: channels.channelsSnapshot?.channelMeta?.length
              ? channels.channelsSnapshot.channelMeta.map((entry) => entry.id)
              : (channels.channelsSnapshot?.channelOrder ?? []),
            channelLabels: channels.channelsSnapshot?.channelLabels ?? {},
            channelMeta: channels.channelsSnapshot?.channelMeta ?? [],
            runsJobId: this.cron.cronRunsJobId,
            runs: this.cron.cronRuns,
            runsTotal: this.cron.cronRunsTotal,
            runsHasMore: this.cron.cronRunsHasMore,
            runsLoadingMore: this.cron.cronRunsLoadingMore,
            runsScope: this.cron.cronRunsScope,
            runsStatuses: this.cron.cronRunsStatuses,
            runsDeliveryStatuses: this.cron.cronRunsDeliveryStatuses,
            runsStatusFilter: this.cron.cronRunsStatusFilter,
            runsQuery: this.cron.cronRunsQuery,
            runsSortDir: this.cron.cronRunsSortDir,
            fieldErrors: this.cron.cronFieldErrors,
            canSubmit: !hasCronFormErrors(this.cron.cronFieldErrors),
            agentSuggestions: suggestions.agentSuggestions,
            modelSuggestions: suggestions.modelSuggestions,
            thinkingSuggestions: THINKING_SUGGESTIONS,
            timezoneSuggestions: TIMEZONE_SUGGESTIONS,
            deliveryToSuggestions: suggestions.deliveryToSuggestions,
            accountSuggestions: suggestions.accountTargets,
            onFormChange: (patch) => {
              this.cron.cronForm = normalizeCronFormState({ ...this.cron.cronForm, ...patch });
              this.cron.cronFieldErrors = validateCronForm(this.cron.cronForm);
              this.requestCronUpdate();
            },
            onRefresh: () => void this.refreshCron({ tableFilters: true }),
            onAdd: () =>
              void this.runCronTask(async (state) => {
                if (await addCronJob(state)) {
                  state.cronFormCollapsed = true;
                }
              }),
            onEdit: (job) => this.editJob(job),
            onClone: (job) => this.cloneJob(job),
            onCancelEdit: () => {
              cancelCronEdit(this.cron);
              this.cron.cronFormCollapsed = true;
              this.requestCronUpdate();
            },
            onToggleFormCollapsed: (collapsed) => {
              this.cron.cronFormCollapsed = collapsed;
              this.requestCronUpdate();
            },
            onToggle: (job, enabled) =>
              void this.runCronTask((state) => toggleCronJob(state, job, enabled)),
            onRun: (job, mode) =>
              void this.runCronTask((state) => runCronJob(state, job, mode ?? "force")),
            onRemove: (job) => void this.runCronTask((state) => removeCronJob(state, job)),
            onQuickCreate: () => this.openQuickCreate(),
            onLoadRuns: (jobId) =>
              void this.runCronTask(async (state) => {
                updateCronRunsFilter(state, { cronRunsScope: "job" });
                await loadCronRuns(state, jobId);
              }),
            onLoadMoreJobs: () =>
              void this.runCronTask((state) =>
                loadCronJobsPage(state, { append: true, tableFilters: true }),
              ),
            onJobsFiltersChange: (patch) =>
              void this.runCronTask(async (state) => {
                updateCronJobsFilter(state, patch);
                await loadCronJobsPage(state, { append: false, tableFilters: true });
              }),
            onJobsFiltersReset: () =>
              void this.runCronTask(async (state) => {
                updateCronJobsFilter(state, {
                  cronJobsQuery: "",
                  cronJobsEnabledFilter: "all",
                  cronJobsScheduleKindFilter: "all",
                  cronJobsLastStatusFilter: "all",
                  cronJobsSortBy: "nextRunAtMs",
                  cronJobsSortDir: "asc",
                });
                await loadCronJobsPage(state, { append: false, tableFilters: true });
              }),
            onLoadMoreRuns: () => void this.runCronTask((state) => loadMoreCronRuns(state)),
            onRunsFiltersChange: (patch) =>
              void this.runCronTask(async (state) => {
                updateCronRunsFilter(state, patch);
                await loadCronRuns(
                  state,
                  state.cronRunsScope === "all" ? null : state.cronRunsJobId,
                );
              }),
            onNavigateToChat: (sessionKey) =>
              this.context.navigate("chat", { search: searchForSession(sessionKey) }),
          })}
        `,
        "cron",
        (routeId) => this.context.navigate(routeId),
        (routeId) => this.context.preload(routeId),
      )}
    `;
  }
}

customElements.define("openclaw-cron-page", CronPage);
