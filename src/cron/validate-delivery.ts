import type { CronJob } from "./types.js";

export type CronDeliveryValidationError = {
  code:
    | "ambiguous_target"
    | "announce_without_target"
    | "webhook_without_url"
    | "conflicting_targets";
  message: string;
};

/**
 * Validates that a cron job's delivery configuration is unambiguous.
 *
 * Returns undefined if the config is valid, or an error object if ambiguous.
 *
 * Ambiguous configs include:
 * - delivery.mode="announce" with no channel/to target
 * - delivery.mode="announce" with conflicting channel/to from payload
 * - delivery.mode="webhook" with no "to" URL
 * - Multi-channel config where it's unclear which channel to use
 */
export function validateCronDelivery(job: CronJob): CronDeliveryValidationError | undefined {
  if (!job.delivery || typeof job.delivery !== "object") {
    // No delivery config is fine
    return undefined;
  }

  const delivery = job.delivery as Record<string, unknown>;
  const mode = delivery.mode;

  // Webhook mode requires a URL in "to"
  if (mode === "webhook") {
    const to = delivery.to;
    if (!to || typeof to !== "string" || !to.trim()) {
      return {
        code: "webhook_without_url",
        message: `delivery.mode="webhook" requires delivery.to to be a non-empty URL string`,
      };
    }
    return undefined;
  }

  // "none" mode doesn't require any target
  if (mode === "none") {
    return undefined;
  }

  // "announce" or undefined (defaults to announce) requires a target
  const isAnnounce = mode === "announce" || mode === undefined;
  if (!isAnnounce) {
    // Unknown mode, let schema validation catch it
    return undefined;
  }

  // For announce mode, we need either:
  // 1. An explicit delivery.channel + delivery.to, or
  // 2. A payload channel/to target

  const deliveryChannel = delivery.channel;
  const deliveryTo = delivery.to;

  const payload = job.payload;
  const payloadChannel = payload && "channel" in payload ? payload.channel : undefined;
  const payloadTo = payload && "to" in payload ? payload.to : undefined;

  const hasDeliveryTarget =
    (deliveryChannel || deliveryTo) && typeof (deliveryChannel || deliveryTo) === "string";
  const hasPayloadTarget =
    (payloadChannel || payloadTo) && typeof (payloadChannel || payloadTo) === "string";

  // If neither delivery config nor payload specifies a target, it's ambiguous
  if (!hasDeliveryTarget && !hasPayloadTarget) {
    return {
      code: "announce_without_target",
      message: `delivery.mode="announce" (or default) requires either delivery.channel/to or payload.channel/to to be specified`,
    };
  }

  // If both delivery and payload specify different targets, that's ambiguous
  if (hasDeliveryTarget && hasPayloadTarget) {
    const deliveryTargetStr = String(deliveryChannel || deliveryTo);
    const payloadTargetStr = String(payloadChannel || payloadTo);

    if (deliveryTargetStr !== payloadTargetStr) {
      return {
        code: "conflicting_targets",
        message: `delivery.channel/to (${deliveryTargetStr}) conflicts with payload.channel/to (${payloadTargetStr}). Use delivery.channel/to only; payload targets are legacy.`,
      };
    }
  }

  return undefined;
}
