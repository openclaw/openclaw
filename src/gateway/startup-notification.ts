/**
 * Gateway startup notification service
 *
 * Sends notifications to configured targets when the gateway starts.
 */

import { normalizeChannelId } from "../channels/plugins/index.js";
import type { OpenClawConfig } from "../config/config.js";
import { resolveMainSessionKeyFromConfig } from "../config/sessions.js";
import type {
  GatewayStartupNotificationConfig,
  GatewayStartupNotificationTarget,
} from "../config/types.gateway.js";
import { deliverOutboundPayloads } from "../infra/outbound/deliver.js";
import { buildOutboundSessionContext } from "../infra/outbound/session-context.js";
import { resolveOutboundTarget } from "../infra/outbound/targets.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("gateway/startup-notification");

const DEFAULT_MESSAGE = "OpenClaw gateway is now online and ready.";

/**
 * Check if startup notification is enabled and has valid targets
 */
export function isStartupNotificationEnabled(config?: GatewayStartupNotificationConfig): boolean {
  if (!config) {
    return false;
  }
  if (config.enabled !== true) {
    return false;
  }
  if (!Array.isArray(config.targets) || config.targets.length === 0) {
    return false;
  }
  return true;
}

/**
 * Send startup notification to a single target
 */
async function sendNotificationToTarget(params: {
  cfg: OpenClawConfig;
  target: GatewayStartupNotificationTarget;
  message: string;
}): Promise<boolean> {
  const { cfg, target, message } = params;

  const channelRaw = target.channel?.trim();
  const to = target.to?.trim();

  if (!channelRaw || !to) {
    log.warn("Skipping invalid startup notification target", {
      channel: channelRaw,
      hasTo: Boolean(to),
    });
    return false;
  }

  const channel = normalizeChannelId(channelRaw);
  if (!channel) {
    log.warn("Unknown channel for startup notification", { channel: channelRaw });
    return false;
  }

  const resolved = resolveOutboundTarget({
    channel,
    to,
    cfg,
    accountId: target.accountId,
    mode: "implicit",
  });

  if (!resolved.ok) {
    log.warn("Failed to resolve outbound target for startup notification", {
      channel,
      to,
      error: resolved.error,
    });
    return false;
  }

  // Use main session key for outbound context
  const sessionKey = resolveMainSessionKeyFromConfig();
  const outboundSession = buildOutboundSessionContext({
    cfg,
    sessionKey,
  });

  try {
    await deliverOutboundPayloads({
      cfg,
      channel,
      to: resolved.to,
      accountId: target.accountId,
      payloads: [{ text: message }],
      session: outboundSession,
      bestEffort: true,
    });
    log.info("Startup notification sent", { channel, to });
    return true;
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log.warn("Failed to send startup notification", {
      channel,
      to,
      error: errorMessage,
    });
    return false;
  }
}

/**
 * Send startup notifications to all configured targets
 */
export async function sendStartupNotifications(params: {
  cfg: OpenClawConfig;
  config?: GatewayStartupNotificationConfig;
}): Promise<{ sent: number; failed: number }> {
  const { cfg, config } = params;

  if (!isStartupNotificationEnabled(config)) {
    return { sent: 0, failed: 0 };
  }

  const message = config?.message?.trim() || DEFAULT_MESSAGE;
  const targets = config?.targets || [];

  log.info("Sending startup notifications", {
    targetCount: targets.length,
  });

  let sent = 0;
  let failed = 0;

  // Send notifications sequentially to avoid overwhelming the channels
  for (const target of targets) {
    const success = await sendNotificationToTarget({ cfg, target, message });
    if (success) {
      sent++;
    } else {
      failed++;
    }
  }

  log.info("Startup notifications completed", { sent, failed });
  return { sent, failed };
}
