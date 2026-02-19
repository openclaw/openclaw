import type { WebhookRequestBody } from "@line/bot-sdk";

export function parseLineWebhookBody(rawBody: string): WebhookRequestBody | null {
  try {
    return JSON.parse(rawBody) as WebhookRequestBody;
  } catch {
    return null;
  }
}

export function isLineWebhookVerificationRequest(
  body: WebhookRequestBody | null | undefined,
): boolean {
  return !!body && Array.isArray(body.events) && body.events.length === 0;
}
