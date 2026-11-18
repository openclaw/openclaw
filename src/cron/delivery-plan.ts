/** Resolves cron result routing from job config. */
import {
  normalizeOptionalString,
  normalizeOptionalThreadValue,
} from "@openclaw/normalization-core/string-coerce";
import { resolveTargetPrefixedChannel } from "../infra/outbound/channel-target-prefix.js";
import { normalizeMessageChannel } from "../utils/message-channel-core.js";
import {
  cronDeliveryUsesDefaultDestination,
  resolveCronDefaultDeliveryDestination,
  resolveCronDeliveryMode,
  type CronDeliveryDefaultsScope,
} from "./delivery-defaults.js";
import type { CronDelivery, CronJob, CronMessageChannel } from "./types.js";

/** Normalized routing plan for a cron job's primary delivery behavior. */
export type CronDeliveryPlan = Pick<
  CronDelivery,
  "mode" | "target" | "directPolicy" | "channel" | "to" | "threadId" | "accountId"
> & {
  source: "delivery";
  requested: boolean;
};

function resolveAnnounceChannel(params: {
  channel?: CronMessageChannel;
  to?: string;
}): CronMessageChannel {
  if (params.channel && params.channel !== "last") {
    return params.channel;
  }
  // A prefixed recipient like "slack:C123" is enough to infer the channel when
  // the cron config intentionally leaves channel at "last" or unset.
  return resolveTargetPrefixedChannel(params.to) ?? params.channel ?? "last";
}

/**
 * Resolves primary delivery config into the runtime mode/channel/target plan.
 * Pass `defaults` wherever the plan routes or previews a chat send so configured
 * default destinations apply; mode-only readers may omit it.
 */
export function resolveCronDeliveryPlan(
  job: Pick<CronJob, "delivery"> & Partial<Pick<CronJob, "payload" | "sessionTarget">>,
  defaults?: CronDeliveryDefaultsScope,
): CronDeliveryPlan {
  const delivery = job.delivery;
  const resolvedMode = resolveCronDeliveryMode(job);

  // Look up the configured default first: it is absent on most Gateways, and the
  // eligibility check normalizes every routing field.
  const defaultDestination = resolveCronDefaultDeliveryDestination(defaults);
  if (defaultDestination && cronDeliveryUsesDefaultDestination(job, resolvedMode)) {
    // Defaults are resolved per run, never written to the job, so editing config
    // moves every route-less announce job without rewriting stored rows.
    const to = normalizeOptionalString(defaultDestination.to);
    return {
      mode: "announce",
      directPolicy: delivery?.directPolicy,
      channel: resolveAnnounceChannel({
        channel: normalizeMessageChannel(defaultDestination.channel),
        to,
      }),
      to,
      threadId: normalizeOptionalThreadValue(defaultDestination.threadId),
      accountId: normalizeOptionalString(defaultDestination.accountId),
      source: "delivery",
      requested: true,
    };
  }

  const deliveryChannel = normalizeMessageChannel(delivery?.channel);
  const to = normalizeOptionalString(delivery?.to);
  const deliveryThreadId = normalizeOptionalThreadValue(delivery?.threadId);
  const deliveryAccountId = normalizeOptionalString(delivery?.accountId);
  if (delivery) {
    const channel =
      resolvedMode === "announce"
        ? resolveAnnounceChannel({ channel: deliveryChannel, to })
        : deliveryChannel;
    return {
      mode: resolvedMode,
      target: delivery.target,
      directPolicy: delivery.directPolicy,
      channel: resolvedMode === "webhook" ? undefined : channel,
      to,
      threadId: resolvedMode === "webhook" ? undefined : deliveryThreadId,
      accountId: deliveryAccountId,
      source: "delivery",
      requested: resolvedMode === "announce",
    };
  }

  // Isolated/current/session output jobs default to announce delivery so their
  // result reaches the initiating session unless the job opts out. Keep this
  // aligned with create-time normalization and direct service callers.
  return {
    mode: resolvedMode,
    channel: resolvedMode === "announce" ? "last" : undefined,
    to: undefined,
    threadId: undefined,
    source: "delivery",
    requested: resolvedMode === "announce",
  };
}
