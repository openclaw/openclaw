/** Shared create- and run-time defaults for cron result delivery. */
import {
  normalizeOptionalString,
  normalizeOptionalThreadValue,
} from "@openclaw/normalization-core/string-coerce";
import {
  sessionCreatorProfileId,
  type SessionCreatedActor,
} from "../config/sessions/session-entry-provenance.js";
import { normalizeMessageChannel } from "../utils/message-channel-core.js";
import { tryResolveCronJobEffectiveAgentId } from "./agent-id.js";
import type { CronDeliveryDefaultsScope } from "./delivery-config-defaults.js";
import { hasExplicitCronDeliveryTarget } from "./delivery-target-validation.js";
import { assertCanonicalCronDeliveryMode } from "./store/delivery-codec.js";
import type { CronAgentScope } from "./types-shared.js";
import type { CronDelivery, CronJob } from "./types.js";

export {
  resolveCronDefaultDeliveryDestination,
  resolveCronFailureAlertDefaults,
  type CronDeliveryDefaultsScope,
} from "./delivery-config-defaults.js";

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
