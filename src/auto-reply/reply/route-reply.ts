/**
 * Provider-agnostic reply router.
 *
 * Routes replies to the originating channel based on OriginatingChannel/OriginatingTo
 * instead of using the session's lastChannel. This ensures replies go back to the
 * provider where the message originated, even when the main session is shared
 * across multiple providers.
 */

import type { ClawdbotConfig } from "../../config/config.js";
import { sendMessageDiscord } from "../../discord/send.js";
import { sendMessageIMessage } from "../../imessage/send.js";
import { sendMessageSignal } from "../../signal/send.js";
import { sendMessageSlack } from "../../slack/send.js";
import { sendMessageTelegram } from "../../telegram/send.js";
import type { OriginatingChannelType } from "../templating.js";
import type { ReplyPayload } from "../types.js";

export type RouteReplyParams = {
  /** The reply payload to send. */
  payload: ReplyPayload;
  /** The originating channel type (telegram, slack, etc). */
  channel: OriginatingChannelType;
  /** The destination chat/channel/user ID. */
  to: string;
  /** Config for provider-specific settings. */
  cfg: ClawdbotConfig;
};

export type RouteReplyResult = {
  /** Whether the reply was sent successfully. */
  ok: boolean;
  /** Optional message ID from the provider. */
  messageId?: string;
  /** Error message if the send failed. */
  error?: string;
};

/**
 * Routes a reply payload to the specified channel.
 *
 * This function provides a unified interface for sending messages to any
 * supported provider. It's used by the followup queue to route replies
 * back to the originating channel when OriginatingChannel/OriginatingTo
 * are set.
 */
export async function routeReply(
  params: RouteReplyParams,
): Promise<RouteReplyResult> {
  const { payload, channel, to } = params;
  const text = payload.text ?? "";
  const mediaUrl = payload.mediaUrl ?? payload.mediaUrls?.[0];

  // Skip empty replies.
  if (!text.trim() && !mediaUrl) {
    return { ok: true };
  }

  try {
    switch (channel) {
      case "telegram": {
        const result = await sendMessageTelegram(to, text, { mediaUrl });
        return { ok: true, messageId: result.messageId };
      }

      case "slack": {
        const result = await sendMessageSlack(to, text, { mediaUrl });
        return { ok: true, messageId: result.messageId };
      }

      case "discord": {
        const result = await sendMessageDiscord(to, text, { mediaUrl });
        return { ok: true, messageId: result.messageId };
      }

      case "signal": {
        const result = await sendMessageSignal(to, text, { mediaUrl });
        return { ok: true, messageId: result.messageId };
      }

      case "imessage": {
        const result = await sendMessageIMessage(to, text, { mediaUrl });
        return { ok: true, messageId: result.messageId };
      }

      case "whatsapp": {
        // WhatsApp doesn't have a standalone send function in this codebase.
        // Falls through to unknown channel handling.
        return {
          ok: false,
          error: `WhatsApp routing not yet implemented`,
        };
      }

      case "webchat": {
        // Webchat is typically handled differently (real-time WebSocket).
        // Falls through to unknown channel handling.
        return {
          ok: false,
          error: `Webchat routing not supported for queued replies`,
        };
      }

      default: {
        // Exhaustive check for unknown channel types.
        const _exhaustive: never = channel;
        return {
          ok: false,
          error: `Unknown channel: ${String(_exhaustive)}`,
        };
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      error: `Failed to route reply to ${channel}: ${message}`,
    };
  }
}

/**
 * Checks if a channel type is routable via routeReply.
 *
 * Some channels (webchat, whatsapp) require special handling and
 * cannot be routed through this generic interface.
 */
export function isRoutableChannel(
  channel: OriginatingChannelType | undefined,
): channel is "telegram" | "slack" | "discord" | "signal" | "imessage" {
  if (!channel) return false;
  return ["telegram", "slack", "discord", "signal", "imessage"].includes(
    channel,
  );
}
