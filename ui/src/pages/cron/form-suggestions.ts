import type { ConversationListItem } from "@openclaw/gateway-protocol";
import {
  normalizeSortedUniqueTrimmedStringList,
  normalizeTrimmedStringList,
} from "@openclaw/normalization-core/string-normalization";
import type { AgentsListResult } from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { listSelectableAgents } from "../../lib/agents/display.ts";
import { currentConfigObject } from "../../lib/config/config-state-model.ts";
import { getCronJobPayload, resolveConfiguredCronModelSuggestions } from "../../lib/cron/index.ts";
import type { CronState } from "../../lib/cron/types.ts";
import { resolveCronTimezoneSuggestions } from "./timezone-suggestions.ts";

export const THINKING_SUGGESTIONS = ["off", "minimal", "low", "medium", "high"];

/**
 * Reduces a fetched conversation directory to plain target suggestions for the
 * account the operator actually selected.
 *
 * The directory read is bounded, so it can never prove that a target is
 * reachable through exactly one account/topic route. Filtering happens here,
 * locally, against the account field the operator authored: an empty account
 * yields nothing rather than exposing rows that belong to a sender nobody has
 * chosen yet, and the returned strings carry no hidden routing.
 */
export function resolveConversationTargetSuggestions(
  conversations: readonly ConversationListItem[],
  accountIdRaw: string,
): string[] {
  const accountId = accountIdRaw.trim();
  if (!accountId) {
    return [];
  }
  return normalizeSortedUniqueTrimmedStringList(
    conversations
      .filter((conversation) => conversation.accountId === accountId)
      .map((conversation) => conversation.target),
  );
}

export function buildCronSuggestions(params: {
  channels: ApplicationContext["channels"]["state"];
  runtimeConfig: ApplicationContext["runtimeConfig"]["state"];
  cron: CronState;
  agentsList: AgentsListResult | null;
  modelSuggestions: string[];
  conversationTargets?: readonly string[];
}) {
  const configValue = currentConfigObject(params.runtimeConfig);
  const channel = params.cron.cronForm.deliveryChannel.trim() || "last";
  const systemAgentIds = new Set(
    (params.agentsList?.agents ?? [])
      .filter((entry) => entry.kind === "system")
      .map((entry) => entry.id.trim()),
  );
  const agentSuggestions = normalizeSortedUniqueTrimmedStringList([
    ...listSelectableAgents(params.agentsList?.agents ?? []).map((entry) => entry.id.trim()),
    ...params.cron.cronJobs.map((job) =>
      typeof job.agentId === "string" && !systemAgentIds.has(job.agentId.trim())
        ? job.agentId.trim()
        : "",
    ),
  ]);
  const modelSuggestions = normalizeSortedUniqueTrimmedStringList([
    ...params.modelSuggestions,
    ...resolveConfiguredCronModelSuggestions(configValue),
    ...params.cron.cronJobs.map((job) => {
      const payload = getCronJobPayload(job);
      return payload?.kind === "agentTurn" && typeof payload.model === "string"
        ? payload.model.trim()
        : "";
    }),
  ]);
  const savedDeliveryTargets = normalizeSortedUniqueTrimmedStringList(
    params.cron.cronJobs.map((job) => job.delivery?.to),
  );
  const deliveryTargets = normalizeSortedUniqueTrimmedStringList([
    ...savedDeliveryTargets,
    ...(params.cron.cronForm.deliveryMode === "announce" ? (params.conversationTargets ?? []) : []),
  ]);
  const accountTargets = normalizeTrimmedStringList(
    (channel === "last"
      ? Object.values(params.channels.channelsSnapshot?.channelAccounts ?? {}).flat()
      : (params.channels.channelsSnapshot?.channelAccounts?.[channel] ?? [])
    ).flatMap((account) => [account.accountId, account.name]),
  );
  const forDeliveryMode = (targets: string[]) =>
    params.cron.cronForm.deliveryMode === "webhook"
      ? targets.filter((value) => /^https?:\/\//i.test(value))
      : targets;
  return {
    agentSuggestions,
    modelSuggestions,
    timezoneSuggestions: resolveCronTimezoneSuggestions(params.cron.cronJobs),
    accountTargets,
    failureAlertToSuggestions: forDeliveryMode(savedDeliveryTargets),
    deliveryToSuggestions: forDeliveryMode(deliveryTargets),
  };
}
