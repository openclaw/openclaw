import { getGlobalHookRunner } from "../plugins/hook-runner-global.js";
import { createInternalHookEvent, triggerInternalHook } from "./internal-hooks.js";

/**
 * Fire message:sent hooks (plugin + internal) for inline delivery paths.
 *
 * Mirrors the hook emission in src/infra/outbound/deliver.ts (emitMessageSent),
 * extracted as a shared utility so channel-specific deliverReplies functions
 * can fire hooks without routing through the centralized outbound path.
 *
 * Both hooks are fire-and-forget — errors are caught and swallowed.
 */
export function emitMessageSentHook(params: {
  to: string;
  content: string;
  success: boolean;
  error?: string;
  messageId?: string;
  channelId: string;
  accountId?: string;
  sessionKey?: string;
}): void {
  const { to, content, success, error, messageId, channelId, accountId, sessionKey } = params;

  // Plugin hook
  const hookRunner = getGlobalHookRunner();
  if (hookRunner?.hasHooks("message_sent")) {
    void hookRunner
      .runMessageSent(
        {
          to,
          content,
          success,
          ...(error ? { error } : {}),
        },
        {
          channelId,
          accountId,
          conversationId: to,
        },
      )
      .catch(() => {});
  }

  // Internal hook (requires sessionKey)
  if (!sessionKey) {
    return;
  }
  void triggerInternalHook(
    createInternalHookEvent("message", "sent", sessionKey, {
      to,
      content,
      success,
      ...(error ? { error } : {}),
      channelId,
      accountId,
      conversationId: to,
      messageId,
    }),
  ).catch(() => {});
}
