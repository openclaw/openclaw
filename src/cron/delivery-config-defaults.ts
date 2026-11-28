import { normalizeAgentId } from "@openclaw/normalization-core/agent-id";
import type {
  CronConfig,
  CronDefaultDeliveryDestinationConfig,
  CronFailureDestinationConfig,
} from "../config/types.cron.js";

/** Gateway config, job owner, and job creator used to select configured default destinations. */
export type CronDeliveryDefaultsScope = {
  cronConfig?: Pick<CronConfig, "delivery" | "failureAlert" | "agents" | "creators">;
  /** Effective agent that owns the job; selects `cron.agents.<agentId>` defaults. */
  agentId?: string;
  /** Gateway profile of the human who created the job; selects `cron.creators.<profileId>`. */
  creatorProfileId?: string;
};

function resolveCreatorCronDefaults(scope: CronDeliveryDefaultsScope | undefined) {
  const creators = scope?.cronConfig?.creators;
  const profileId = scope?.creatorProfileId?.trim();
  // Profile ids are opaque Gateway identifiers: match exactly, never normalize.
  return creators && profileId && Object.hasOwn(creators, profileId)
    ? creators[profileId]
    : undefined;
}

function resolveAgentCronDefaults(scope: CronDeliveryDefaultsScope | undefined) {
  const agents = scope?.cronConfig?.agents;
  const agentId = scope?.agentId?.trim();
  if (!agents || !agentId) {
    return undefined;
  }
  const normalized = normalizeAgentId(agentId);
  for (const [key, value] of Object.entries(agents)) {
    if (normalizeAgentId(key) === normalized) {
      return value;
    }
  }
  return undefined;
}

/**
 * The most specific configured primary destination wins whole (creator, then
 * owner agent, then Gateway) instead of merging fields, because a recipient,
 * thread, and account belong to the channel that supplied them.
 */
export function resolveCronDefaultDeliveryDestination(
  scope: CronDeliveryDefaultsScope | undefined,
): CronDefaultDeliveryDestinationConfig | undefined {
  return (
    resolveCreatorCronDefaults(scope)?.delivery ??
    resolveAgentCronDefaults(scope)?.delivery ??
    scope?.cronConfig?.delivery
  );
}

/**
 * Returns the failure-alert config whose route fields come from the job creator's
 * default, else the owner agent's default, when one exists. Tuning (enabled,
 * after, cooldown, skipped runs) stays Gateway-wide; the scoped route replaces
 * the global route fields whole.
 */
export function resolveCronFailureAlertDefaults(
  scope: CronDeliveryDefaultsScope | undefined,
): CronConfig["failureAlert"] {
  const global = scope?.cronConfig?.failureAlert;
  const agentRoute: CronFailureDestinationConfig | undefined =
    resolveCreatorCronDefaults(scope)?.failureAlert ??
    resolveAgentCronDefaults(scope)?.failureAlert;
  if (!agentRoute) {
    return global;
  }
  return {
    ...global,
    mode: agentRoute.mode,
    channel: agentRoute.channel,
    to: agentRoute.to,
    threadId: agentRoute.threadId,
    accountId: agentRoute.accountId,
  };
}
