import type { WebhookRequestBody } from "@line/bot-sdk";
import type { LineWebhookEnvelope } from "./types.js";

export function parseLineWebhookBody(rawBody: string): WebhookRequestBody | null {
  try {
    return JSON.parse(rawBody) as WebhookRequestBody;
  } catch {
    return null;
  }
}

export function isLineVerificationProbe(
  body: WebhookRequestBody | LineWebhookEnvelope | null | undefined,
): boolean {
  return Boolean(body && Array.isArray(body.events) && body.events.length === 0);
}
