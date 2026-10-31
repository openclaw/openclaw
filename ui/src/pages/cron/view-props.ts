import {
  normalizeSortedUniqueTrimmedStringList,
  normalizeTrimmedStringList,
} from "@openclaw/normalization-core/string-normalization";
import { listSelectableAgents } from "../../lib/agents/display.ts";
import { currentConfigObject } from "../../lib/config/config-state-model.ts";
import { hasCronFormErrors } from "../../lib/cron/form.ts";
import { resolveConfiguredCronModelSuggestions } from "../../lib/cron/model-suggestions.ts";
import { getCronRunsViewState } from "../../lib/cron/runs.ts";
import { resolveTimezoneSuggestions } from "../../lib/timezone-suggestions.ts";
import type { createCronPage } from "./cron-page-state.ts";
import { validateCronEventSelection } from "./event-source.ts";

const THINKING_SUGGESTIONS = ["off", "minimal", "low", "medium", "high"];

export function buildCronViewProps(page: ReturnType<typeof createCronPage>) {
  const channels = page.inventories.channels.read();
  const runtimeConfig = page.inventories.runtimeConfig.read();
  const cron = page.cron();
  const agentsList = page.inventories.agents.read().agentsList;
  let agentSuggestions: string[] = [];
  let modelSuggestions: string[] = [];
  let timezoneSuggestions: string[] = [];
  let accountSuggestions: string[] = [];
  let failureAlertToSuggestions: string[] = [];
  let deliveryToSuggestions: string[] = [];
  // Only the editor consumes these inventories; list updates must not rebuild them.
  if (cron.cronCreateOpen || (cron.cronEditingJob && page.detailTab() !== "history")) {
    const conversations = page.deliveryDirectory.conversations;
    const accountId = page.cron().cronForm.deliveryAccountId.trim();
    // The bounded directory cannot prove a unique account/topic route. Only the
    // operator's explicit account supplies plain targets; never infer routing.
    const conversationTargets = accountId
      ? normalizeSortedUniqueTrimmedStringList(
          conversations
            .filter((conversation) => conversation.accountId === accountId)
            .map((conversation) => conversation.target),
        )
      : [];
    const configValue = currentConfigObject(runtimeConfig);
    const channel = cron.cronForm.deliveryChannel.trim() || "last";
    const systemAgentIds = new Set(
      (agentsList?.agents ?? [])
        .filter((entry) => entry.kind === "system")
        .map((entry) => entry.id.trim()),
    );
    agentSuggestions = normalizeSortedUniqueTrimmedStringList([
      ...listSelectableAgents(agentsList?.agents ?? []).map((entry) => entry.id.trim()),
      ...cron.cronJobs.map((job) =>
        typeof job.agentId === "string" && !systemAgentIds.has(job.agentId.trim())
          ? job.agentId.trim()
          : "",
      ),
    ]);
    modelSuggestions = normalizeSortedUniqueTrimmedStringList([
      ...page.cronModelSuggestions(),
      ...resolveConfiguredCronModelSuggestions(configValue),
      ...cron.cronJobs.map((job) => {
        const payload = job.payload;
        return payload.kind === "agentTurn" && typeof payload.model === "string"
          ? payload.model.trim()
          : "";
      }),
    ]);
    const savedDeliveryTargets = normalizeSortedUniqueTrimmedStringList(
      cron.cronJobs.map((job) => job.delivery?.to),
    );
    const deliveryTargets = normalizeSortedUniqueTrimmedStringList([
      ...savedDeliveryTargets,
      ...(cron.cronForm.deliveryMode === "announce" ? conversationTargets : []),
    ]);
    const accountTargets = normalizeTrimmedStringList(
      (channel === "last"
        ? Object.values(channels.channelsSnapshot?.channelAccounts ?? {}).flat()
        : (channels.channelsSnapshot?.channelAccounts?.[channel] ?? [])
      ).map((account) => account.accountId),
    );
    const forDeliveryMode = (targets: string[]) =>
      cron.cronForm.deliveryMode === "webhook"
        ? targets.filter((value) => /^https?:\/\//i.test(value))
        : targets;
    timezoneSuggestions = resolveTimezoneSuggestions(
      cron.cronJobs.map((job) => (job.schedule.kind === "cron" ? (job.schedule.tz ?? "") : "")),
    );
    accountSuggestions = accountTargets;
    failureAlertToSuggestions = forDeliveryMode(savedDeliveryTargets);
    deliveryToSuggestions = forDeliveryMode(deliveryTargets);
  }
  const canManage = page.canManageCron();
  const eventSource = page.eventSource.view;
  const fieldErrors = {
    ...page.cron().cronFieldErrors,
    ...validateCronEventSelection(page.cron().cronForm, eventSource),
  };
  return {
    ...page.actions,
    gateway: page.context().gateway,
    getActionRetired: page.getActionRetired,
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
    reads: page.reads,
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
    error: page.cron().cronError ?? page.cron().cronRunsError ?? page.deliveryDirectory.error,
    notice: page.cron().cronNotice,
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
    agentSuggestions,
    modelSuggestions,
    thinkingSuggestions: THINKING_SUGGESTIONS,
    timezoneSuggestions,
    deliveryToSuggestions,
    failureAlertToSuggestions,
    accountSuggestions,
  };
}
