/**
 * LINQ webhook signature verification and event processing.
 *
 * Webhook headers:
 *   X-Webhook-Event       – event type (e.g. "message.received")
 *   X-Webhook-Subscription-ID – subscription reference
 *   X-Webhook-Timestamp   – unix timestamp (seconds)
 *   X-Webhook-Signature   – HMAC-SHA256 hex digest
 *
 * Signature is computed over: "{timestamp}.{rawBody}"
 * using the signing secret as the HMAC key.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

export type LinqWebhookHeaders = {
  event: string;
  subscriptionId: string;
  timestamp: string;
  signature: string;
};

export function extractWebhookHeaders(
  headers: Record<string, string | string[] | undefined>,
): LinqWebhookHeaders | null {
  const event = headerValue(headers, "x-webhook-event");
  const subscriptionId = headerValue(headers, "x-webhook-subscription-id");
  const timestamp = headerValue(headers, "x-webhook-timestamp");
  const signature = headerValue(headers, "x-webhook-signature");
  if (!event || !timestamp || !signature) {
    return null;
  }
  return { event, subscriptionId: subscriptionId ?? "", timestamp, signature };
}

function headerValue(
  headers: Record<string, string | string[] | undefined>,
  key: string,
): string | undefined {
  const value = headers[key] ?? headers[key.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

export function verifyWebhookSignature(
  signingSecret: string,
  rawBody: string | Buffer,
  timestamp: string,
  signature: string,
): boolean {
  const payload = typeof rawBody === "string" ? rawBody : rawBody.toString("utf-8");
  const message = `${timestamp}.${payload}`;
  const expected = createHmac("sha256", signingSecret)
    .update(message)
    .digest("hex");
  try {
    return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch {
    return false;
  }
}

// Webhook event types
export const LINQ_WEBHOOK_EVENTS = [
  "message.sent",
  "message.received",
  "message.read",
  "message.delivered",
  "message.failed",
  "reaction.added",
  "reaction.removed",
  "participant.added",
  "participant.removed",
  "chat.created",
  "chat.group_name_updated",
  "chat.group_icon_updated",
  "chat.group_name_update_failed",
  "chat.group_icon_update_failed",
  "chat.typing_indicator.started",
  "chat.typing_indicator.stopped",
] as const;

export type LinqWebhookEvent = (typeof LINQ_WEBHOOK_EVENTS)[number];
