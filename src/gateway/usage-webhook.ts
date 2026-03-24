/**
 * Usage Webhook Reporter (Gateway)
 *
 * Reports usage data to external webhook after each message completion.
 * Used for billing/tracking integration with dashboard systems like Hidrix.
 */

import type { OpenClawConfig } from "../config/config.js";
import { resolveSecretInputString } from "../secrets/resolve-secret-input-string.js";

export interface UsageWebhookPayload {
  /** Workspace identifier (derived from session key). */
  workspaceId?: string;
  /** Action type. */
  action: "chat";
  /** Model used. */
  model?: string;
  /** Input tokens. */
  inputTokens: number;
  /** Output tokens. */
  outputTokens: number;
  /** Originating channel. */
  channel?: string;
  /** Session key for correlation. */
  sessionKey?: string;
  /** Timestamp. */
  timestamp: string;
}

/**
 * Report usage to configured webhook (non-blocking).
 * Fails silently if webhook is not configured or request fails.
 */
export async function reportUsageToWebhookIfConfigured(params: {
  cfg: OpenClawConfig;
  usage?: { input?: number; output?: number };
  model?: string;
  channel?: string;
  sessionKey?: string;
}): Promise<void> {
  const webhookConfig = params.cfg.gateway?.usageWebhook;
  if (!webhookConfig?.url) {
    return;
  }

  const { usage, model, channel, sessionKey } = params;

  // Skip if no meaningful usage
  const inputTokens = usage?.input ?? 0;
  const outputTokens = usage?.output ?? 0;
  if (inputTokens === 0 && outputTokens === 0) {
    return;
  }

  // Derive workspaceId from session key pattern like "uuid:session"
  let workspaceId: string | undefined;
  if (sessionKey) {
    const parts = sessionKey.split(":");
    if (parts[0] && parts[0].includes("-")) {
      workspaceId = parts[0]; // UUID format
    }
  }

  const payload: UsageWebhookPayload = {
    workspaceId,
    action: "chat",
    model,
    inputTokens,
    outputTokens,
    channel,
    sessionKey,
    timestamp: new Date().toISOString(),
  };

  try {
    const tokenHeader = webhookConfig.tokenHeader ?? "X-Gateway-Token";
    const tokenValue = webhookConfig.token ?? params.cfg.gateway?.auth?.token;
    const token = tokenValue 
      ? await resolveSecretInputString({
          config: params.cfg,
          value: tokenValue,
          env: process.env,
        })
      : undefined;

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    if (token) {
      headers[tokenHeader] = token;
    }

    const response = await fetch(webhookConfig.url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(5000), // 5s timeout
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "unknown");
      console.warn(
        `[usage-webhook] POST to ${webhookConfig.url} failed: ${response.status} ${errorText}`,
      );
    } else {
      // Optional: log success for debugging
      // console.log(`[usage-webhook] reported ${inputTokens}+${outputTokens} tokens for ${channel}`);
    }
  } catch (error) {
    console.warn(`[usage-webhook] request failed: ${String(error)}`);
  }
}
