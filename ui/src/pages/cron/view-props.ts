import {
  normalizeSortedUniqueTrimmedStringList,
  normalizeTrimmedStringList,
} from "@openclaw/normalization-core/string-normalization";
import { userProfileDisplayName } from "../../../../src/shared/user-profile-display-name.js";
import type { GatewayAgentRow } from "../../api/types.ts";
import { hasCronFormErrors } from "../../lib/cron/form.ts";
import { getCronRunsViewState } from "../../lib/cron/runs.ts";
import type { ModelCatalogPresentation } from "../../lib/model-catalog-store.ts";
import { profileDirectory } from "../../lib/profile-directory.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { resolveTimezoneSuggestions } from "../../lib/timezone-suggestions.ts";
import type { createCronPage } from "./cron-page-state.ts";
import { validateCronEventSelection } from "./event-source.ts";
type CronModelSource = {
  catalog: ModelCatalogPresentation | undefined;
  agent: GatewayAgentRow | undefined;
};

export function buildCronViewProps(page: ReturnType<typeof createCronPage>) {
  const channels = page.inventories.channels.read();
  // Event sources list MCP servers from the runtime config; track its arrival.
  page.inventories.runtimeConfig.read();
  const cron = page.cron();
  const agentsList = page.inventories.agents.read().agentsList;
  let models: CronModelSource = { catalog: undefined, agent: undefined };
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
    const channel = cron.cronForm.deliveryChannel.trim() || "last";
    const modelAgentId = page.resolveModelAgentId(cron);
    models = {
      catalog: page.cronModelCatalog(),
      agent: agentsList?.agents.find((entry) => entry.id === modelAgentId),
    };
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
  const canManage =
    cron.cronEditingJob || cron.cronCreateOpen
      ? page.canManageCron()
      : page.canCreateCron() || cron.cronJobs.some(page.canManageJob);
  const directory = profileDirectory(page.context().gateway);
  const selectedOwner = cron.cronForm.ownerProfileId;
  const profiles = directory.result?.profiles.filter((profile) => !profile.mergedInto) ?? [];
  const ownerOptions = profiles.map((profile) => ({
    value: profile.id,
    label:
      userProfileDisplayName(profile.id, profile.displayName, profile.githubIdentity?.login) ||
      profile.id,
  }));
  if (!selectedOwner || !profiles.some((profile) => profile.id === selectedOwner)) {
    ownerOptions.unshift({
      value: selectedOwner,
      label: selectedOwner || t("cron.form.ownerUnassigned"),
    });
  }
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
    listError: page.cron().cronJobsError,
    /** Canonical gateway capability for every mutation-capable cron control. */
    canManage,
    ownerOptions,
    connected: page.cron().connected,
    status: page.cron().cronStatus,
    jobs: page.cron().cronJobs,
    reads: page.reads,
    editingJob: page.cron().cronEditingJob,
    /** A copy starts from its source's name, so its create form shows the name field. */
    cloning: page.cron().cronCloningJob !== null,
    createOpen: page.cron().cronCreateOpen,
    activityOpen: page.activityOpen(),
    detailTab: page.detailTab(),
    error: page.cron().cronError ?? page.deliveryDirectory.error,
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
    runsError: page.cron().cronRunsError,
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
    agentsList,
    models,
    timezoneSuggestions,
    deliveryToSuggestions,
    failureAlertToSuggestions,
    accountSuggestions,
  };
}
