import { hasCronFormErrors } from "../../lib/cron/index.ts";
import { getCronRunsViewState } from "../../lib/cron/runs.ts";
import type { createCronPage } from "./cron-page-state.ts";
import { validateCronEventSelection } from "./event-source.ts";
import {
  buildCronSuggestions,
  resolveConversationTargetSuggestions,
  THINKING_SUGGESTIONS,
} from "./form-suggestions.ts";

export function buildCronViewProps(page: ReturnType<typeof createCronPage>) {
  const channels = page.inventories.channels.read();
  const suggestions = buildCronSuggestions({
    channels,
    runtimeConfig: page.inventories.runtimeConfig.read(),
    cron: page.cron(),
    agentsList: page.inventories.agents.read().agentsList,
    modelSuggestions: page.cronModelSuggestions(),
    conversationTargets: resolveConversationTargetSuggestions(
      page.deliveryDirectory.conversations,
      page.cron().cronForm.deliveryAccountId,
    ),
  });
  const canManage = page.canManageCron();
  const eventSource = page.eventSource.view;
  const fieldErrors = {
    ...page.cron().cronFieldErrors,
    ...validateCronEventSelection(page.cron().cronForm, eventSource),
  };
  return {
    ...page.actions,
    gateway: page.context().gateway,
    onRunMount: page.registerRun,
    loading: page.cron().cronLoading,
    /** True once a cron.list response has completed (initial load finished). */
    hasLoaded: page.cron().cronJobsSnapshotRevision !== null,
    listError: page.cron().cronJobsError,
    /** Canonical gateway capability for every mutation-capable cron control. */
    canManage,
    connected: page.cron().connected,
    status: page.cron().cronStatus,
    jobs: page.cron().cronJobs,
    jobsLoadingMore: page.cron().cronJobsLoadingMore,
    jobsTotal: page.cron().cronJobsTotal,
    jobsHasMore: page.cron().cronJobsHasMore,
    jobsQuery: page.cron().cronJobsQuery,
    jobsEnabledFilter: page.cron().cronJobsEnabledFilter,
    jobsScheduleKindFilter: page.cron().cronJobsScheduleKindFilter,
    jobsLastStatusFilter: page.cron().cronJobsLastStatusFilter,
    jobsTriggerFilter: page.cron().cronJobsTriggerFilter,
    jobsSortBy: page.cron().cronJobsSortBy,
    jobsSortDir: page.cron().cronJobsSortDir,
    editingJob: page.cron().cronEditingJob,
    createOpen: page.cron().cronCreateOpen,
    listTab: page.listTab(),
    detailTab: page.detailTab(),
    error:
      page.cron().cronError ??
      page.cron().cronRunsError ??
      page.deliveryDirectory.error ??
      page.modelSuggestionsError(),
    busy: page.cron().cronBusy,
    form: page.cron().cronForm,
    channels: channels.channelsSnapshot?.channelMeta?.length
      ? channels.channelsSnapshot.channelMeta.map((entry) => entry.id)
      : (channels.channelsSnapshot?.channelOrder ?? []),
    channelLabels: channels.channelsSnapshot?.channelLabels ?? {},
    channelMeta: channels.channelsSnapshot?.channelMeta ?? [],
    runs: page.cron().cronRuns,
    runsState: getCronRunsViewState(page.cron()),
    highlightedRunId: page.cron().cronRunsRunId,
    runsHasMore: page.cron().cronRunsHasMore,
    runsLoadingMore: page.cron().cronRunsLoadingMore,
    runsStatuses: page.cron().cronRunsStatuses,
    runsDeliveryStatuses: page.cron().cronRunsDeliveryStatuses,
    runsQuery: page.cron().cronRunsQuery,
    runsSortDir: page.cron().cronRunsSortDir,
    eventSource,
    fieldErrors,
    canSubmit: page.cron().connected && !hasCronFormErrors(fieldErrors),
    agentSuggestions: suggestions.agentSuggestions,
    modelSuggestions: suggestions.modelSuggestions,
    thinkingSuggestions: THINKING_SUGGESTIONS,
    timezoneSuggestions: suggestions.timezoneSuggestions,
    deliveryToSuggestions: suggestions.deliveryToSuggestions,
    failureAlertToSuggestions: suggestions.failureAlertToSuggestions,
    accountSuggestions: suggestions.accountTargets,
  };
}
