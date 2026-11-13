/** Shared create- and run-time defaults for cron result delivery. */
import { normalizeAgentId } from "@openclaw/normalization-core/agent-id";
import {
  normalizeOptionalString,
  normalizeOptionalThreadValue,
} from "@openclaw/normalization-core/string-coerce";
import {
  sessionCreatorProfileId,
  type SessionCreatedActor,
} from "../config/sessions/session-entry-provenance.js";
import type {
  CronConfig,
  CronDefaultDeliveryDestinationConfig,
  CronFailureDestinationConfig,
} from "../config/types.cron.js";
import { normalizeMessageChannel } from "../utils/message-channel-core.js";
import { tryResolveCronJobEffectiveAgentId } from "./agent-id.js";
import { hasExplicitCronDeliveryTarget } from "./delivery-target-validation.js";
import { assertCanonicalCronDeliveryMode } from "./store/delivery-codec.js";
import type { CronAgentScope } from "./types-shared.js";
import type { CronDelivery, CronJob } from "./types.js";

/** Gateway config, job owner, and job creator used to select configured default destinations. */
export type CronDeliveryDefaultsScope = {
  cronConfig?: Pick<CronConfig, "delivery" | "failureAlert" | "agents" | "creators">;
  /** Effective agent that owns the job; selects `cron.agents.<agentId>` defaults. */
  agentId?: string;
  /** Gateway profile of the human who created the job; selects `cron.creators.<profileId>`. */
  creatorProfileId?: string;
};

/**
 * Builds the defaults scope for one job. The owner follows cron ownership
 * (explicit agentId, then the session-key agent, then the default agent) so
 * create, preview, run, and failure-alert paths select the same agent defaults.
 * The creator is the trusted, creation-stamped human profile attribution
 * (including a profile that delegated creation to an agent); legacy jobs without
 * `createdActor` and channel-only, unknown, agent, or system creators have none.
 */
export function resolveCronDeliveryDefaultsScope(
  cronConfig: CronDeliveryDefaultsScope["cronConfig"],
  job: CronAgentScope & { createdActor?: SessionCreatedActor },
  defaultAgentId: string | undefined,
): CronDeliveryDefaultsScope {
  return {
    cronConfig,
    agentId: tryResolveCronJobEffectiveAgentId(job, defaultAgentId),
    creatorProfileId: sessionCreatorProfileId(job.createdActor),
  };
}

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

/**
 * Routing fields read from a stored delivery or from raw create-time tool input,
 * which has not been through the delivery codec yet.
 */
type CronDeliveryRouteFields = Partial<
  Record<"target" | "channel" | "to" | "threadId" | "accountId", unknown>
>;

/**
 * A configured default destination replaces the remembered session route of any
 * announce job that names no route of its own. `none` and `webhook` never gain a
 * chat destination, and any job routing field (channel other than `last`, `to`,
 * `threadId`, `accountId`, or owner targeting) keeps the job on its own route.
 */
export function cronDeliveryUsesDefaultDestination(
  job: { delivery?: CronDeliveryRouteFields },
  mode: CronDelivery["mode"],
): boolean {
  if (mode !== "announce") {
    return false;
  }
  const delivery = job.delivery;
  return (
    !delivery ||
    !hasExplicitCronDeliveryTarget({
      target: delivery.target === "owner" ? "owner" : undefined,
      channel: normalizeMessageChannel(normalizeOptionalString(delivery.channel)),
      to: normalizeOptionalString(delivery.to),
      threadId: normalizeOptionalThreadValue(delivery.threadId),
      accountId: normalizeOptionalString(delivery.accountId),
    })
  );
}

/**
 * Keep create-time normalization, direct service persistence, and run-time
 * planning on one target policy; disagreement silently drops cron results.
 */
export function shouldDefaultCronDeliveryToAnnounce(params: {
  payloadKind: unknown;
  sessionTarget: unknown;
}): boolean {
  if (
    params.payloadKind !== "agentTurn" &&
    params.payloadKind !== "command" &&
    params.payloadKind !== "script"
  ) {
    return false;
  }
  return (
    params.sessionTarget === "isolated" ||
    params.sessionTarget === "current" ||
    (typeof params.sessionTarget === "string" && params.sessionTarget.startsWith("session:"))
  );
}

/** Resolves the configured mode without loading runtime destination routing. */
export function resolveCronDeliveryMode(
  job: Pick<CronJob, "delivery"> & Partial<Pick<CronJob, "payload" | "sessionTarget">>,
): CronDelivery["mode"] {
  assertCanonicalCronDeliveryMode(job.delivery);
  if (job.delivery) {
    return job.delivery.mode;
  }
  return job.payload &&
    job.sessionTarget &&
    shouldDefaultCronDeliveryToAnnounce({
      payloadKind: job.payload.kind,
      sessionTarget: job.sessionTarget,
    })
    ? "announce"
    : "none";
}
