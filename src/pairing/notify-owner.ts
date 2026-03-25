/**
 * Pairing request owner notification.
 *
 * Sends a direct notification to the owner when a new pairing request arrives.
 * The notification bypasses the AI agent context entirely to prevent injection
 * attacks from requester-controlled metadata (name, contact info, etc.).
 */

import type { OpenClawConfig } from "../config/config.js";
import type { PairingNotifyConfig } from "../config/types.pairing.js";
import {
  isPairingRequestEvent,
  registerInternalHook,
  unregisterInternalHook,
  type InternalHookHandler,
} from "../hooks/internal-hooks.js";
import type { OutboundSendDeps } from "../infra/outbound/deliver.js";

type ChannelSendFn = (target: string, text: string, opts?: { accountId?: string }) => Promise<void>;
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("pairing-notify");

/**
 * Build a safe, fixed-format notification string.
 * All fields are treated as untrusted and truncated to prevent abuse.
 */
function buildNotificationText(params: {
  requesterId: string;
  channelId: string;
  code: string;
  meta?: Record<string, string>;
}): string {
  const name = sanitizeField(params.meta?.name || params.meta?.displayName || "unknown", 64);
  const contact = sanitizeField(params.requesterId, 64);
  const channel = sanitizeField(params.channelId, 32);
  const code = sanitizeField(params.code, 16);
  return `Pairing request: ${name} (${contact}) via ${channel} — code ${code}`;
}

/** Truncate and strip control characters from untrusted input. */
function sanitizeField(value: string, maxLength: number): string {
  // Strip C0/C1 control chars and zero-width/bidi chars that could be used for injection.
  // eslint-disable-next-line no-control-regex -- intentional: sanitizing untrusted input
  const cleaned = value.replace(
    // oxlint-disable-next-line eslint/no-control-regex -- intentional: sanitizing untrusted input
    /[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u2028-\u202F\u2066-\u2069\uFEFF]/g,
    "",
  );
  return cleaned.slice(0, maxLength);
}

export type PairingNotifyDeps = {
  cfg: OpenClawConfig;
  sendDeps?: OutboundSendDeps;
};

async function sendNotification(params: {
  notifyConfig: PairingNotifyConfig;
  text: string;
  sendDeps?: OutboundSendDeps;
}): Promise<void> {
  const { notifyConfig, text, sendDeps } = params;
  const target = notifyConfig.target?.trim();
  if (!target) {
    return;
  }

  const channel = notifyConfig.channel?.trim().toLowerCase() || "imessage";
  const accountId = notifyConfig.accountId?.trim();

  switch (channel) {
    case "imessage": {
      const send = sendDeps?.sendIMessage as ChannelSendFn | undefined;
      if (!send) {
        log.warn("pairing-notify: iMessage send function not available");
        return;
      }
      await send(target, text, { accountId });
      break;
    }
    case "telegram": {
      const send = sendDeps?.sendTelegram as ChannelSendFn | undefined;
      if (!send) {
        log.warn("pairing-notify: Telegram send function not available");
        return;
      }
      await send(target, text, { accountId });
      break;
    }
    case "whatsapp": {
      const send = sendDeps?.sendWhatsApp as ChannelSendFn | undefined;
      if (!send) {
        log.warn("pairing-notify: WhatsApp send function not available");
        return;
      }
      await send(target, text, { accountId });
      break;
    }
    case "discord": {
      const send = sendDeps?.sendDiscord as ChannelSendFn | undefined;
      if (!send) {
        log.warn("pairing-notify: Discord send function not available");
        return;
      }
      await send(target, text, { accountId });
      break;
    }
    case "signal": {
      const send = sendDeps?.sendSignal as ChannelSendFn | undefined;
      if (!send) {
        log.warn("pairing-notify: Signal send function not available");
        return;
      }
      await send(target, text, { accountId });
      break;
    }
    case "slack": {
      const send = sendDeps?.sendSlack as ChannelSendFn | undefined;
      if (!send) {
        log.warn("pairing-notify: Slack send function not available");
        return;
      }
      await send(target, text, { accountId });
      break;
    }
    case "matrix":
    case "msteams":
      log.error(
        `pairing-notify: channel "${channel}" is not yet supported — notification not sent`,
      );
      break;
    default:
      log.warn(`pairing-notify: unsupported notification channel "${channel}"`);
  }
}

function resolvePairingNotifyConfig(cfg: OpenClawConfig): PairingNotifyConfig | null {
  const notify = cfg.pairing?.notify;
  if (!notify) {
    return null;
  }
  if (!notify.target?.trim()) {
    return null;
  }
  if (notify.enabled === false) {
    return null;
  }
  return notify;
}

let registeredHandler: InternalHookHandler | null = null;

/**
 * Register the pairing notification hook.
 * Call once at gateway startup after config and send deps are available.
 */
export function registerPairingNotifyHook(deps: PairingNotifyDeps): void {
  // Unregister any previous handler (e.g., on config reload).
  unregisterPairingNotifyHook();

  const notifyConfig = resolvePairingNotifyConfig(deps.cfg);
  if (!notifyConfig) {
    log.info("pairing-notify: no notification target configured; hook not registered");
    return;
  }

  const handler: InternalHookHandler = async (event) => {
    if (!isPairingRequestEvent(event)) {
      return;
    }

    const text = buildNotificationText({
      requesterId: event.context.requesterId,
      channelId: event.context.channelId,
      code: event.context.code,
      meta: event.context.meta,
    });

    try {
      await sendNotification({
        notifyConfig,
        text,
        sendDeps: deps.sendDeps,
      });
    } catch (err) {
      log.warn(
        `pairing-notify: failed to send notification: ${String((err as Error)?.message ?? err)}`,
      );
    }
  };

  registeredHandler = handler;
  registerInternalHook("pairing:request", handler);
  const target = notifyConfig.target!; // Guaranteed by resolvePairingNotifyConfig
  const maskedTarget = target.length > 4 ? `***${target.slice(-4)}` : "****";
  log.info(
    `pairing-notify: hook registered (channel=${notifyConfig.channel || "imessage"}, target=${maskedTarget})`,
  );
}

/** Unregister the pairing notification hook. */
export function unregisterPairingNotifyHook(): void {
  if (registeredHandler) {
    unregisterInternalHook("pairing:request", registeredHandler);
    registeredHandler = null;
  }
}

// Exported for testing.
export { buildNotificationText, sanitizeField, resolvePairingNotifyConfig, sendNotification };
