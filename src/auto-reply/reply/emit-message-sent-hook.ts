/**
 * Emit the `message:sent` internal hook and plugin hook for agent replies
 * delivered through channel-specific dispatcher paths (Discord, Telegram, Slack, etc.)
 * that bypass `deliverOutboundPayloads`.
 *
 * Refs #31293.
 */

import { createInternalHookEvent, triggerInternalHook } from "../../hooks/internal-hooks.js";
import { getGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import type { ReplyPayload } from "../types.js";

export interface MessageSentHookContext {
  sessionKey?: string;
  channelId: string;
  accountId?: string;
  to: string;
}

/**
 * Emit `message_sent` hooks (both internal and plugin) after a reply payload
 * has been successfully delivered through the dispatcher path.
 *
 * Wraps in try/catch so hook failures never break the reply flow.
 */
export function emitMessageSentHookForReply(
  payload: ReplyPayload,
  hookCtx: MessageSentHookContext,
): void {
  const content = payload.text ?? "";
  const { sessionKey, channelId, accountId, to } = hookCtx;

  try {
    // Plugin hook (fire-and-forget)
    const hookRunner = getGlobalHookRunner();
    if (hookRunner?.hasHooks("message_sent")) {
      void hookRunner
        .runMessageSent(
          {
            to,
            content,
            success: true,
          },
          {
            channelId,
            accountId,
            conversationId: to,
          },
        )
        .catch(() => {});
    }

    // Internal hook (fire-and-forget)
    if (sessionKey) {
      void triggerInternalHook(
        createInternalHookEvent("message", "sent", sessionKey, {
          to,
          content,
          success: true,
          channelId,
          accountId,
          conversationId: to,
        }),
      ).catch(() => {});
    }
  } catch {
    // Never break the reply flow due to hook failures
  }
}
