import { html } from "lit";
import { DEFAULT_CRON_FORM } from "./app-defaults.ts";
import { switchChatSession } from "./app-render.helpers.ts";
import type { AppViewState } from "./app-view-state.ts";
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
} from "./controllers/cron.ts";
import { getCronJobPayload } from "./cron-payload.ts";
import { resolveConfiguredCronModelSuggestions, sortLocaleStrings } from "./views/agents-utils.ts";
import {
  createDefaultDraft,
  draftToCronFormPatch,
  renderCronQuickCreate,
} from "./views/cron-quick-create.ts";
import { renderCron } from "./views/cron.ts";

const CRON_THINKING_SUGGESTIONS = ["off", "minimal", "low", "medium", "high"];
const CRON_TIMEZONE_SUGGESTIONS = [
  "UTC",
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "Europe/London",
  "Europe/Berlin",
  "Asia/Tokyo",
  "Australia/Sydney",
];

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value.trim());
}

function normalizeSuggestionValue(value: unknown): string {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function uniquePreserveOrder(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (!value || seen.has(value)) {
      continue;
    }
    seen.add(value);
    result.push(value);
  }
  return result;
}

function renderCronQuickCreateForTab(
  state: AppViewState,
  requestHostUpdate: (() => void) | undefined,
) {
  return renderCronQuickCreate({
    open: state.cronQuickCreateOpen,
    step: state.cronQuickCreateStep,
    draft: state.cronQuickCreateDraft ?? createDefaultDraft(),
    onDraftChange: (patch) => {
      state.cronQuickCreateDraft = {
        ...(state.cronQuickCreateDraft ?? createDefaultDraft()),
        ...patch,
      };
      requestHostUpdate?.();
    },
    onStepChange: (step) => {
      state.cronQuickCreateStep = step;
      requestHostUpdate?.();
    },
    onCreate: () => {
      const draft = state.cronQuickCreateDraft ?? createDefaultDraft();
      const formPatch = draftToCronFormPatch(draft);
      state.cronEditingJobId = null;
      state.cronForm = { ...DEFAULT_CRON_FORM, ...formPatch } as typeof state.cronForm;
      requestHostUpdate?.();
      void (async () => {
        await addCronJob(state);
        if (state.cronError || hasCronFormErrors(state.cronFieldErrors)) {
          requestHostUpdate?.();
          return;
        }
        state.cronQuickCreateOpen = false;
        state.cronQuickCreateStep = "what";
        state.cronQuickCreateDraft = null;
        requestHostUpdate?.();
      })();
    },
    onCancel: () => {
      state.cronQuickCreateOpen = false;
      state.cronQuickCreateStep = "what";
      state.cronQuickCreateDraft = null;
      requestHostUpdate?.();
    },
  });
}

export function renderCronTab(
  state: AppViewState,
  options: {
    configValue: Record<string, unknown> | null;
    requestHostUpdate?: () => void;
  },
) {
  const cronAgentSuggestions = sortLocaleStrings(
    new Set(
      [
        ...(state.agentsList?.agents?.map((entry) => entry.id.trim()) ?? []),
        ...state.cronJobs
          .map((job) => (typeof job.agentId === "string" ? job.agentId.trim() : ""))
          .filter(Boolean),
      ].filter(Boolean),
    ),
  );
  const cronModelSuggestions = sortLocaleStrings(
    new Set(
      [
        ...state.cronModelSuggestions,
        ...resolveConfiguredCronModelSuggestions(options.configValue),
        ...state.cronJobs
          .map((job) => {
            const payload = getCronJobPayload(job);
            if (payload?.kind !== "agentTurn" || typeof payload.model !== "string") {
              return "";
            }
            return payload.model.trim();
          })
          .filter(Boolean),
      ].filter(Boolean),
    ),
  );
  const visibleCronJobs = getVisibleCronJobs(state);
  const selectedDeliveryChannel =
    state.cronForm.deliveryChannel && state.cronForm.deliveryChannel.trim()
      ? state.cronForm.deliveryChannel.trim()
      : "last";
  const jobToSuggestions = state.cronJobs
    .map((job) => normalizeSuggestionValue(job.delivery?.to))
    .filter(Boolean);
  const accountToSuggestions = (
    selectedDeliveryChannel === "last"
      ? Object.values(state.channelsSnapshot?.channelAccounts ?? {}).flat()
      : (state.channelsSnapshot?.channelAccounts?.[selectedDeliveryChannel] ?? [])
  )
    .flatMap((account) => [
      normalizeSuggestionValue(account.accountId),
      normalizeSuggestionValue(account.name),
    ])
    .filter(Boolean);
  const rawDeliveryToSuggestions = uniquePreserveOrder([
    ...jobToSuggestions,
    ...accountToSuggestions,
  ]);
  const accountSuggestions = uniquePreserveOrder(accountToSuggestions);
  const deliveryToSuggestions =
    state.cronForm.deliveryMode === "webhook"
      ? rawDeliveryToSuggestions.filter((value) => isHttpUrl(value))
      : rawDeliveryToSuggestions;

  return html`
    ${renderCronQuickCreateForTab(state, options.requestHostUpdate)}
    ${renderCron({
      basePath: state.basePath,
      loading: state.cronLoading,
      status: state.cronStatus,
      jobs: visibleCronJobs,
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
      agentSuggestions: cronAgentSuggestions,
      modelSuggestions: cronModelSuggestions,
      thinkingSuggestions: CRON_THINKING_SUGGESTIONS,
      timezoneSuggestions: CRON_TIMEZONE_SUGGESTIONS,
      deliveryToSuggestions,
      accountSuggestions,
      onFormChange: (patch) => {
        state.cronForm = normalizeCronFormState({ ...state.cronForm, ...patch });
        state.cronFieldErrors = validateCronForm(state.cronForm);
      },
      onRefresh: () => state.loadCron(),
      onAdd: () => addCronJob(state),
      onEdit: (job) => {
        state.cronFormCollapsed = false;
        startCronEdit(state, job);
      },
      onClone: (job) => {
        state.cronFormCollapsed = false;
        startCronClone(state, job);
      },
      onCancelEdit: () => cancelCronEdit(state),
      onToggleFormCollapsed: (collapsed) => {
        state.cronFormCollapsed = collapsed;
      },
      onToggle: (job, enabled) => toggleCronJob(state, job, enabled),
      onRun: (job, mode) => runCronJob(state, job, mode ?? "force"),
      onRemove: (job) => removeCronJob(state, job),
      onQuickCreate: () => {
        state.cronQuickCreateOpen = true;
        state.cronQuickCreateStep = "what";
        state.cronQuickCreateDraft = createDefaultDraft();
        options.requestHostUpdate?.();
      },
      onLoadRuns: async (jobId) => {
        updateCronRunsFilter(state, { cronRunsScope: "job" });
        await loadCronRuns(state, jobId);
      },
      onLoadMoreJobs: () => loadCronJobsPage(state, { append: true }),
      onJobsFiltersChange: async (patch) => {
        updateCronJobsFilter(state, patch);
        const shouldReload =
          typeof patch.cronJobsQuery === "string" ||
          Boolean(patch.cronJobsEnabledFilter) ||
          Boolean(patch.cronJobsSortBy) ||
          Boolean(patch.cronJobsSortDir);
        if (shouldReload) {
          await loadCronJobsPage(state, { append: false });
        }
      },
      onJobsFiltersReset: async () => {
        updateCronJobsFilter(state, {
          cronJobsQuery: "",
          cronJobsEnabledFilter: "all",
          cronJobsScheduleKindFilter: "all",
          cronJobsLastStatusFilter: "all",
          cronJobsSortBy: "nextRunAtMs",
          cronJobsSortDir: "asc",
        });
        await loadCronJobsPage(state, { append: false });
      },
      onLoadMoreRuns: () => loadMoreCronRuns(state),
      onRunsFiltersChange: async (patch) => {
        updateCronRunsFilter(state, patch);
        if (state.cronRunsScope === "all") {
          await loadCronRuns(state, null);
          return;
        }
        await loadCronRuns(state, state.cronRunsJobId);
      },
      onNavigateToChat: (sessionKey) => {
        switchChatSession(state, sessionKey);
        state.setTab("chat" as import("./navigation.ts").Tab);
      },
    })}
  `;
}
