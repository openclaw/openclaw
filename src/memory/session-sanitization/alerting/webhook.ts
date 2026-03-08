import crypto from "node:crypto";
import { createSubsystemLogger } from "../../../logging/subsystem.js";
import type { AlertPayload } from "../types.js";
import type { ResolvedAlertingConfig } from "./config.js";

const log = createSubsystemLogger("memory/session-sanitization/alerting/webhook");

/** Sign a webhook payload: HMAC-SHA256(secret, timestamp + "." + body). */
function sign(body: string, secret: string, timestamp: string): string {
  return `sha256=${crypto.createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;
}

async function tryDeliver(
  url: string,
  body: string,
  signature: string,
  timestamp: string,
  severity: string,
  timeoutMs: number,
): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-OpenClaw-Alert-Severity": severity,
          "X-OpenClaw-Timestamp": timestamp,
          "X-OpenClaw-Signature": signature,
          "X-OpenClaw-Event": "alert",
        },
        body,
        signal: controller.signal,
      });
      return response.ok;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return false;
  }
}

/**
 * Deliver an alert payload to the configured webhook endpoint.
 *
 * Signs the body with HMAC-SHA256 if a secret is configured.
 * Retries up to `cfg.channels.webhook.retries` times on failure with
 * `retryDelayMs` between attempts. No-ops if no URL is configured.
 */
export async function deliverWebhook(
  payload: AlertPayload,
  cfg: ResolvedAlertingConfig,
): Promise<void> {
  const { url, secret, retries, retryDelayMs, timeoutMs } = cfg.channels.webhook;
  if (!url) return;

  const body = JSON.stringify(payload);

  if (!secret) {
    log.warn("alerting webhook: no secret configured — payload will not be signed", {
      alertId: payload.alertId,
    });
  }

  let attempt = 0;
  while (attempt <= retries) {
    // Refresh timestamp/signature on each attempt so replay-window checks stay valid.
    const timestamp = new Date().toISOString();
    const signature = secret ? sign(body, secret, timestamp) : "sha256=unsigned";
    const ok = await tryDeliver(url, body, signature, timestamp, payload.severity, timeoutMs);
    if (ok) return;
    attempt++;
    if (attempt <= retries) {
      await new Promise<void>((resolve) => setTimeout(resolve, retryDelayMs));
    }
  }

  log.warn("alerting webhook: all delivery attempts failed", {
    alertId: payload.alertId,
    ruleId: payload.ruleId,
    attempts: retries + 1,
  });
}
