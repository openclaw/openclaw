// ─────────────────────────────────────────────
//  OpenClaw Shield — Webhook Dispatch
//  HMAC-SHA256 signed security notifications
//  with retry logic for anomaly alerting.
//  Adapted from Kairos Shield Protocol
//  By Kairos Lab
// ─────────────────────────────────────────────

import { createHmac, timingSafeEqual } from "node:crypto";

// ─── Types ───────────────────────────────────

export interface WebhookPayload {
  event_type: string;
  severity: number;
  timestamp: string;
  data: Record<string, unknown>;
}

export interface WebhookHeaders {
  "Content-Type": string;
  "X-Shield-Signature": string;
  "X-Shield-Timestamp": string;
  "X-Shield-Event": string;
}

export interface WebhookAttempt {
  attempt: number;
  status: "delivered" | "failed";
  responseCode: number | null;
  errorMessage: string | null;
  timestamp: string;
}

export interface WebhookResult {
  webhookId: string;
  eventType: string;
  status: "delivered" | "failed";
  attempts: WebhookAttempt[];
  totalAttempts: number;
}

// ─── Constants ───────────────────────────────

export const MAX_RETRY_ATTEMPTS = 3;
export const RETRY_DELAYS_MS = [1000, 4000, 16000];

// ─── HMAC-SHA256 Signing ─────────────────────

export function signWebhookPayload(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("hex");
}

export function verifyWebhookSignature(
  payload: string,
  signature: string,
  secret: string,
): boolean {
  const expected = signWebhookPayload(payload, secret);
  if (expected.length !== signature.length) {
    return false;
  }
  return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(signature, "hex"));
}

export function buildWebhookHeaders(
  payload: string,
  secret: string,
  eventType: string,
): WebhookHeaders {
  return {
    "Content-Type": "application/json",
    "X-Shield-Signature": signWebhookPayload(payload, secret),
    "X-Shield-Timestamp": new Date().toISOString(),
    "X-Shield-Event": eventType,
  };
}

// ─── Retry Logic ─────────────────────────────

export function getRetryDelay(attempt: number): number {
  if (attempt < 0 || attempt >= RETRY_DELAYS_MS.length) {
    return RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1];
  }
  return RETRY_DELAYS_MS[attempt];
}

export function shouldRetry(responseCode: number | null): boolean {
  if (responseCode === null) {
    return true;
  }
  return responseCode >= 500;
}

export function prepareWebhookDispatch(
  webhookId: string,
  payload: WebhookPayload,
  secret: string,
): {
  body: string;
  headers: WebhookHeaders;
  webhookId: string;
  maxAttempts: number;
  retryDelays: number[];
} {
  const body = JSON.stringify(payload);
  const headers = buildWebhookHeaders(body, secret, payload.event_type);

  return {
    body,
    headers,
    webhookId,
    maxAttempts: MAX_RETRY_ATTEMPTS,
    retryDelays: [...RETRY_DELAYS_MS],
  };
}
