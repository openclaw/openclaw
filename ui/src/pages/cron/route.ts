import { html } from "lit";
import { titleForRoute, subtitleForRoute } from "../../app-navigation.ts";
import type { SettingsAppHost, SettingsHost } from "../../app/app-host.ts";
import { definePage } from "../../router/index.ts";
import { DEFAULT_CRON_FORM } from "../../ui/app-defaults.ts";
import { switchChatSession } from "../../ui/app-render.helpers.ts";
import type { AppViewState } from "../../ui/app-view-state.ts";
import {
  addCronJob,
  cancelCronEdit,
  getVisibleCronJobs,
  hasCronFormErrors,
  loadCronJobsPage,
  loadCronRuns,
  loadMoreCronRuns,
  normalizeCronFormState,
  removeCronJob,
  runCronJob,
  startCronClone,
  startCronEdit,
  toggleCronJob,
  updateCronJobsFilter,
  updateCronRunsFilter,
  validateCronForm,
} from "../../ui/controllers/cron.ts";
import { getCronJobPayload } from "../../ui/cron-payload.ts";
import {
  resolveConfiguredCronModelSuggestions,
  sortLocaleStrings,
} from "../../ui/views/agents-utils.ts";
import {
  createDefaultDraft,
  draftToCronFormPatch,
  renderCronQuickCreate,
} from "../../ui/views/cron-quick-create.ts";
import { loadCronPage } from "../loaders.ts";
type CronLoadContext = { host: SettingsHost; app: SettingsAppHost };
type CronRenderContext = { state: AppViewState };
type CronModule = typeof import("../../ui/views/cron.ts");

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
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function runTask<Args extends unknown[]>(
  task: (...args: Args) => Promise<unknown>,
): (...args: Args) => void {
  return (...args) => {
    void task(...args);
  };
}

function renderCronPage(state: AppViewState, module: CronModule) {
  const configValue =
    state.configForm ?? (state.configSnapshot?.config as Record<string, unknown> | null);
  const agentSuggestions = sortLocaleStrings(
    new Set([
      ...(state.agentsList?.agents?.map((entry) => entry.id.trim()) ?? []),
      ...state.cronJobs
        .map((job) => (typeof job.agentId === "string" ? job.agentId.trim() : ""))
        .filter(Boolean),
    ]),
  );
  const modelSuggestions = sortLocaleStrings(
    new Set([
      ...state.cronModelSuggestions,
      ...resolveConfiguredCronModelSuggestions(configValue),
      ...state.cronJobs
        .map((job) => {
          const payload = getCronJobPayload(job);
          return payload?.kind === "agentTurn" && typeof payload.model === "string"
            ? payload.model.trim()
            : "";
        })
        .filter(Boolean),
    ]),
  );
  const jobs = getVisibleCronJobs(state);
  const channel = state.cronForm.deliveryChannel.trim() || "last";
  const jobTargets = state.cronJobs
    .map((job) => (typeof job.delivery?.to === "string" ? job.delivery.to.trim() : ""))
    .filter(Boolean);
  const accountTargets = (
    channel === "last"
      ? Object.values(state.channelsSnapshot?.channelAccounts ?? {}).flat()
      : (state.channelsSnapshot?.channelAccounts?.[channel] ?? [])
  )
    .flatMap((account) => [account.accountId, account.name])
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim())
    .filter(Boolean);
  const deliveryTargets = unique([...jobTargets, ...accountTargets]);
  const deliveryToSuggestions =
    state.cronForm.deliveryMode === "webhook"
      ? deliveryTargets.filter((value) => /^https?:\/\//i.test(value))
      : deliveryTargets;
  const requestUpdate = (state as AppViewState & { requestUpdate?: () => void }).requestUpdate;

  return html`
    <section class="content-header">
      <div>
        <div class="page-title">${titleForRoute("cron")}</div>
        <div class="page-sub">${subtitleForRoute("cron")}</div>
      </div>
    </section>
    ${renderCronQuickCreate({
      open: state.cronQuickCreateOpen,
      step: state.cronQuickCreateStep,
      draft: state.cronQuickCreateDraft ?? createDefaultDraft(),
      onCancel: () => {
        state.cronQuickCreateOpen = false;
        requestUpdate?.();
      },
      onStepChange: (step) => {
        state.cronQuickCreateStep = step;
        requestUpdate?.();
      },
      onDraftChange: (patch) => {
        state.cronQuickCreateDraft = {
          ...(state.cronQuickCreateDraft ?? createDefaultDraft()),
          ...patch,
        };
        requestUpdate?.();
      },
      onCreate: () => {
        const draft = state.cronQuickCreateDraft ?? createDefaultDraft();
        state.cronEditingJobId = null;
        state.cronForm = normalizeCronFormState({
          ...DEFAULT_CRON_FORM,
          ...draftToCronFormPatch(draft),
        });
        state.cronFieldErrors = validateCronForm(state.cronForm);
        state.cronFormCollapsed = false;
        requestUpdate?.();
        void (async () => {
          if (!(await addCronJob(state))) {
            requestUpdate?.();
            return;
          }
          state.cronQuickCreateOpen = false;
          state.cronQuickCreateStep = "what";
          state.cronQuickCreateDraft = null;
          requestUpdate?.();
        })();
      },
      onAdvancedCreate: () => {
        const draft = state.cronQuickCreateDraft ?? createDefaultDraft();
        state.cronEditingJobId = null;
        state.cronForm = normalizeCronFormState({
          ...DEFAULT_CRON_FORM,
          ...draftToCronFormPatch(draft),
        });
        state.cronFieldErrors = validateCronForm(state.cronForm);
        state.cronQuickCreateOpen = false;
        state.cronQuickCreateStep = "what";
        state.cronQuickCreateDraft = null;
        state.cronFormCollapsed = false;
        requestUpdate?.();
      },
    })}
    ${module.renderCron({
      basePath: state.basePath,
      loading: state.cronLoading,
      status: state.cronStatus,
      jobs,
      jobsLoadingMore: state.cronJobsLoadingMore,
      jobsTotal: state.cronJobsTotal,
      jobsHasMore: state.cronJobsHasMore,
      jobsQuery: state.cronJobsQuery,
      jobsEnabledFilter: state.cronJobsEnabledFilter,
      jobsScheduleKindFilter: state.cronJobsScheduleKindFilter,
      jobsLastStatusFilter: state.cronJobsLastStatusFilter,
      jobsSortBy: state.cronJobsSortBy,
      jobsSortDir: state.cronJobsSortDir,
      editingJobId: state.cronEditingJobId,
      error: state.cronError,
      busy: state.cronBusy,
      form: state.cronForm,
      cronFormCollapsed: state.cronFormCollapsed,
      channels: state.channelsSnapshot?.channelMeta?.length
        ? state.channelsSnapshot.channelMeta.map((entry) => entry.id)
        : (state.channelsSnapshot?.channelOrder ?? []),
      channelLabels: state.channelsSnapshot?.channelLabels ?? {},
      channelMeta: state.channelsSnapshot?.channelMeta ?? [],
      runsJobId: state.cronRunsJobId,
      runs: state.cronRuns,
      runsTotal: state.cronRunsTotal,
      runsHasMore: state.cronRunsHasMore,
      runsLoadingMore: state.cronRunsLoadingMore,
      runsScope: state.cronRunsScope,
      runsStatuses: state.cronRunsStatuses,
      runsDeliveryStatuses: state.cronRunsDeliveryStatuses,
      runsStatusFilter: state.cronRunsStatusFilter,
      runsQuery: state.cronRunsQuery,
      runsSortDir: state.cronRunsSortDir,
      fieldErrors: state.cronFieldErrors,
      canSubmit: !hasCronFormErrors(state.cronFieldErrors),
      agentSuggestions,
      modelSuggestions,
      thinkingSuggestions: THINKING_SUGGESTIONS,
      timezoneSuggestions: TIMEZONE_SUGGESTIONS,
      deliveryToSuggestions,
      accountSuggestions: accountTargets,
      onFormChange: (patch) => {
        state.cronForm = normalizeCronFormState({ ...state.cronForm, ...patch });
        state.cronFieldErrors = validateCronForm(state.cronForm);
      },
      onRefresh: () => void state.loadCron(),
      onAdd: runTask(async () => {
        if (await addCronJob(state)) {
          state.cronFormCollapsed = true;
        }
        requestUpdate?.();
      }),
      onEdit: (job) => {
        state.cronFormCollapsed = false;
        startCronEdit(state, job);
      },
      onClone: (job) => {
        state.cronFormCollapsed = false;
        startCronClone(state, job);
      },
      onCancelEdit: () => {
        cancelCronEdit(state);
        state.cronFormCollapsed = true;
        requestUpdate?.();
      },
      onToggleFormCollapsed: (collapsed) => {
        state.cronFormCollapsed = collapsed;
        requestUpdate?.();
      },
      onToggle: (job, enabled) => void toggleCronJob(state, job, enabled),
      onRun: (job, mode) => void runCronJob(state, job, mode ?? "force"),
      onRemove: (job) => void removeCronJob(state, job),
      onQuickCreate: () => {
        state.cronQuickCreateOpen = true;
        state.cronQuickCreateStep = "what";
        state.cronQuickCreateDraft = createDefaultDraft();
        requestUpdate?.();
      },
      onLoadRuns: runTask(async (jobId) => {
        updateCronRunsFilter(state, { cronRunsScope: "job" });
        await loadCronRuns(state, jobId);
      }),
      onLoadMoreJobs: () => void loadCronJobsPage(state, { append: true, tableFilters: true }),
      onJobsFiltersChange: runTask(async (patch) => {
        updateCronJobsFilter(state, patch);
        await loadCronJobsPage(state, { append: false, tableFilters: true });
      }),
      onJobsFiltersReset: runTask(async () => {
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
      onLoadMoreRuns: () => void loadMoreCronRuns(state),
      onRunsFiltersChange: runTask(async (patch) => {
        updateCronRunsFilter(state, patch);
        await loadCronRuns(state, state.cronRunsScope === "all" ? null : state.cronRunsJobId);
      }),
      onNavigateToChat: (sessionKey) => {
        switchChatSession(state, sessionKey);
        state.setRoute("chat");
      },
    })}
  `;
}

export const page = definePage({
  id: "cron",
  path: "/cron",
  loader: ({ host }: CronLoadContext, options) => loadCronPage(host, options),
  component: () =>
    import("../../ui/views/cron.ts").then((module) => ({
      shell: "page" as const,
      header: true,
      render: ({ state }: CronRenderContext) => renderCronPage(state, module),
    })),
});
