import crypto from "node:crypto";
import type { WebhookRequestBody } from "@line/bot-sdk";

const LINE_WEBHOOK_REPLAY_WINDOW_MS = 5 * 60_000;
const LINE_WEBHOOK_REPLAY_MAX_KEYS = 5_000;

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

function stableLineEventIds(body: WebhookRequestBody): string[] {
  const ids = new Set<string>();
  for (const evt of body.events ?? []) {
    const candidate =
      evt && typeof evt === "object" && "webhookEventId" in evt
        ? (evt as { webhookEventId?: unknown }).webhookEventId
        : undefined;
    if (typeof candidate === "string" && candidate.trim()) {
      ids.add(candidate.trim());
    }
  }
  return [...ids].toSorted();
}

export function buildLineWebhookReplayKey(params: {
  signature: string;
  rawBody: string;
  body: WebhookRequestBody;
}): string {
  const eventIds = stableLineEventIds(params.body);
  if (eventIds.length > 0) {
    return `line:event:${eventIds.join(",")}`;
  }
  const bodyHash = crypto.createHash("sha256").update(params.rawBody).digest("hex");
  return `line:sig:${params.signature}:body:${bodyHash}`;
}

export function shouldDropReplayLineWebhookEvent(
  recentReplayKeys: Map<string, number>,
  replayKey: string,
  nowMs: number,
): boolean {
  const seenAt = recentReplayKeys.get(replayKey);
  recentReplayKeys.set(replayKey, nowMs);

  if (typeof seenAt === "number" && nowMs - seenAt < LINE_WEBHOOK_REPLAY_WINDOW_MS) {
    return true;
  }

  if (recentReplayKeys.size > LINE_WEBHOOK_REPLAY_MAX_KEYS) {
    for (const [key, timestamp] of recentReplayKeys) {
      if (nowMs - timestamp >= LINE_WEBHOOK_REPLAY_WINDOW_MS) {
        recentReplayKeys.delete(key);
      }
    }
  }

  return false;
}
