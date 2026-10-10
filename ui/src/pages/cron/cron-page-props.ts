import { hasCronFormErrors } from "../../lib/cron/index.ts";
import { getCronRunsViewState } from "../../lib/cron/runs.ts";
import type { CronPageController } from "./cron-page-controller.ts";
import {
  buildCronSuggestions,
  resolveConversationTargetSuggestions,
  THINKING_SUGGESTIONS,
} from "./form-suggestions.ts";
import type { CronProps } from "./view-types.ts";

type CronPageActions = Pick<CronProps, Extract<keyof CronProps, `on${string}`>>;

export function buildCronPageProps(page: CronPageController, actions: CronPageActions): CronProps {
  const channels = page.context.channels.state;
  const suggestions = buildCronSuggestions({
    channels,
    runtimeConfig: page.context.runtimeConfig.state,
    cron: page.cron,
    agentsList: page.agentsList,
    modelSuggestions: page.cronModelSuggestions,
    conversationTargets: resolveConversationTargetSuggestions(
      page.deliveryDirectory.conversations,
      page.cron.cronForm.deliveryAccountId,
    ),
  });
  const canManage = page.canManageCron;
  return {
    ...actions,
    loading: page.cron.cronLoading,
    hasLoaded: page.cron.cronJobsSnapshotRevision !== null,
    listError: page.cron.cronJobsError,
    canManage,
    status: page.cron.cronStatus,
    jobs: page.cron.cronJobs,
    jobsLoadingMore: page.cron.cronJobsLoadingMore,
    jobsTotal: page.cron.cronJobsTotal,
    jobsHasMore: page.cron.cronJobsHasMore,
    jobsQuery: page.cron.cronJobsQuery,
    jobsEnabledFilter: page.cron.cronJobsEnabledFilter,
    jobsScheduleKindFilter: page.cron.cronJobsScheduleKindFilter,
    jobsLastStatusFilter: page.cron.cronJobsLastStatusFilter,
    jobsTriggerFilter: page.cron.cronJobsTriggerFilter,
    jobsSortBy: page.cron.cronJobsSortBy,
    jobsSortDir: page.cron.cronJobsSortDir,
    editingJob: page.cron.cronEditingJob,
    createOpen: page.cron.cronCreateOpen,
    listTab: page.listTab,
    detailTab: page.detailTab,
    error:
      page.cron.cronError ??
      page.cron.cronRunsError ??
      page.deliveryDirectory.error ??
      page.modelSuggestionsError,
    busy: page.cron.cronBusy,
    form: page.cron.cronForm,
    heartbeatScratch: canManage ? page.heartbeatScratch : "",
    channels: channels.channelsSnapshot?.channelMeta?.length
      ? channels.channelsSnapshot.channelMeta.map((entry) => entry.id)
      : (channels.channelsSnapshot?.channelOrder ?? []),
    channelLabels: channels.channelsSnapshot?.channelLabels ?? {},
    channelMeta: channels.channelsSnapshot?.channelMeta ?? [],
    runs: page.cron.cronRuns,
    runsState: getCronRunsViewState(page.cron),
    highlightedRunId: page.highlightedRunId,
    runsHasMore: page.cron.cronRunsHasMore,
    runsLoadingMore: page.cron.cronRunsLoadingMore,
    runsStatuses: page.cron.cronRunsStatuses,
    runsDeliveryStatuses: page.cron.cronRunsDeliveryStatuses,
    runsQuery: page.cron.cronRunsQuery,
    runsSortDir: page.cron.cronRunsSortDir,
    fieldErrors: page.cron.cronFieldErrors,
    canSubmit: !hasCronFormErrors(page.cron.cronFieldErrors),
    agentSuggestions: suggestions.agentSuggestions,
    modelSuggestions: suggestions.modelSuggestions,
    thinkingSuggestions: THINKING_SUGGESTIONS,
    timezoneSuggestions: suggestions.timezoneSuggestions,
    deliveryToSuggestions: suggestions.deliveryToSuggestions,
    failureAlertToSuggestions: suggestions.failureAlertToSuggestions,
    accountSuggestions: suggestions.accountTargets,
  };
}
