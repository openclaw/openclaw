/** Resolves cron delivery and failure-notification routing from job config. */
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
  normalizeOptionalStringifiedId,
  normalizeOptionalThreadValue,
} from "@openclaw/normalization-core/string-coerce";
import type { CronFailureDestinationConfig } from "../config/types.cron.js";
import { resolveTargetPrefixedChannel } from "../infra/outbound/channel-target-prefix.js";
import { normalizeMessageChannel } from "../utils/message-channel-core.js";
import {
  cronDeliveryUsesDefaultDestination,
  resolveCronDefaultDeliveryDestination,
  resolveCronDeliveryMode,
  type CronDeliveryDefaultsScope,
} from "./delivery-defaults.js";
import { hasCanonicalCronDeliveryMode } from "./store/delivery-codec.js";
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

/** Normalized destination for notifying about cron execution failures. */
type CronFailureDeliveryPlan = CronFailureDestinationInput & {
  mode: "announce" | "webhook";
};

/** Job-level failure destination override fields before global defaults are merged. */
type CronFailureDestinationInput = NonNullable<CronDelivery["failureDestination"]>;

function normalizeFailureMode(value: unknown): "announce" | "webhook" | undefined {
  const trimmed = normalizeOptionalLowercaseString(value);
  if (trimmed === "announce" || trimmed === "webhook") {
    return trimmed;
  }
  return undefined;
}

/** Resolves job-level failure notification routing layered over global defaults. */
export function resolveFailureDestination(
  job: Pick<CronJob, "delivery">,
  globalConfig?: CronFailureDestinationConfig,
  jobAlertRoute?: CronFailureDestinationInput,
): CronFailureDeliveryPlan | null {
  const delivery = job.delivery;
  const jobFailureDest = delivery?.failureDestination;

  let channel: CronMessageChannel | undefined;
  let to: string | undefined;
  let accountId: string | undefined;
  let mode: "announce" | "webhook" | undefined;
  let threadId: string | number | undefined;

  if (globalConfig) {
    channel = normalizeMessageChannel(globalConfig.channel);
    to = normalizeOptionalString(globalConfig.to);
    threadId = normalizeOptionalThreadValue(globalConfig.threadId);
    accountId = normalizeOptionalString(globalConfig.accountId);
    mode = normalizeFailureMode(globalConfig.mode);
  }

  // Apply the delivery override first, then the job's failureAlert route. This
  // is the canonical route layering used by mutation validation and finalization.
  for (const routeOverride of [jobFailureDest, jobAlertRoute]) {
    if (!routeOverride || typeof routeOverride !== "object") {
      continue;
    }
    const overrideTo = normalizeOptionalString(routeOverride.to);
    const explicitOverrideChannel = normalizeMessageChannel(routeOverride.channel);
    const overrideChannel =
      explicitOverrideChannel ??
      (overrideTo ? resolveTargetPrefixedChannel(overrideTo) : undefined);
    const overrideAccountId = normalizeOptionalString(routeOverride.accountId);
    const overrideMode = normalizeFailureMode(routeOverride.mode);
    const hasChannelField = Object.hasOwn(routeOverride, "channel");
    const hasToField = Object.hasOwn(routeOverride, "to");
    const hasAccountIdField = Object.hasOwn(routeOverride, "accountId");
    const hasModeField = Object.hasOwn(routeOverride, "mode");
    const hasThreadField = Object.hasOwn(routeOverride, "threadId");
    const recipientChanged =
      (hasAccountIdField && overrideAccountId !== accountId) ||
      (hasToField && overrideTo !== to) ||
      (overrideChannel !== undefined &&
        overrideChannel !== resolveAnnounceChannel({ channel, to }));
    if (hasThreadField) {
      threadId = normalizeOptionalThreadValue(routeOverride.threadId);
    } else if (recipientChanged) {
      threadId = undefined;
    }

    const hasExplicitTo = hasToField && overrideTo !== undefined;
    const globalChannel = resolveAnnounceChannel({ channel, to });

    if (hasChannelField || (overrideChannel && overrideTo)) {
      channel = overrideChannel;
      if (overrideChannel && overrideChannel !== globalChannel) {
        // Targets and accounts belong to the channel that supplied them.
        if (!hasToField) {
          to = undefined;
        }
        if (!hasAccountIdField) {
          accountId = undefined;
        }
      }
    }
    if (hasToField) {
      to = overrideTo;
    }
    if (hasAccountIdField) {
      accountId = overrideAccountId;
    }
    // Naming a channel makes this an announce route even when mode is omitted;
    // inheriting webhook here would reinterpret the chat target as a URL.
    const overrideImpliesAnnounce = !hasModeField && overrideChannel !== undefined;
    if (hasModeField || overrideImpliesAnnounce) {
      const effectiveOverrideMode = overrideImpliesAnnounce ? "announce" : overrideMode;
      const globalMode = mode ?? "announce";
      const resolvedOverrideMode = effectiveOverrideMode ?? "announce";
      if (globalMode !== resolvedOverrideMode) {
        if (!hasThreadField) {
          threadId = undefined;
        }
        // Chat targets and accounts cannot be reused as webhook routing, or vice versa.
        if (!hasChannelField) {
          channel = undefined;
        }
        if (!hasExplicitTo) {
          to = undefined;
        }
        if (!hasAccountIdField) {
          accountId = undefined;
        }
      }
      mode = effectiveOverrideMode;
    }
  }

  const jobAlertOnlySelectsMode =
    jobAlertRoute?.mode !== undefined &&
    jobAlertRoute.channel === undefined &&
    jobAlertRoute.to === undefined &&
    jobAlertRoute.accountId === undefined &&
    jobAlertRoute.threadId === undefined;
  if (
    !channel &&
    !to &&
    !accountId &&
    threadId === undefined &&
    (!mode || jobAlertOnlySelectsMode)
  ) {
    return null;
  }

  const resolvedMode = mode ?? "announce";
  if (resolvedMode === "webhook" && !to) {
    // Webhook failure destinations are only useful with a concrete URL/target.
    return null;
  }

  const result: CronFailureDeliveryPlan = {
    mode: resolvedMode,
    channel: resolvedMode === "announce" ? resolveAnnounceChannel({ channel, to }) : undefined,
    ...(resolvedMode === "announce" && threadId !== undefined ? { threadId } : {}),
    to,
    accountId,
  };

  if (delivery && isSameDeliveryTarget(delivery, result)) {
    // Avoid sending the same failure text through the primary delivery route twice.
    return null;
  }

  return result;
}

function isSameDeliveryTarget(
  delivery: CronDelivery,
  failurePlan: CronFailureDeliveryPlan,
): boolean {
  const primaryMode = delivery.mode;
  if (!hasCanonicalCronDeliveryMode(delivery) || primaryMode === "none") {
    return false;
  }

  const primaryTo = normalizeOptionalString(delivery.to);
  const primaryAccountId = normalizeOptionalString(delivery.accountId);
  const primaryThreadId = normalizeOptionalStringifiedId(delivery.threadId);

  if (failurePlan.mode === "webhook") {
    return primaryMode === "webhook" && primaryTo === failurePlan.to;
  }

  const primaryChannelNormalized = resolveAnnounceChannel({
    channel: normalizeMessageChannel(delivery.channel),
    to: primaryTo,
  });
  const failureChannelNormalized = failurePlan.channel ?? "last";

  return (
    failureChannelNormalized === primaryChannelNormalized &&
    failurePlan.to === primaryTo &&
    failurePlan.accountId === primaryAccountId &&
    normalizeOptionalStringifiedId(failurePlan.threadId) === primaryThreadId
  );
}
