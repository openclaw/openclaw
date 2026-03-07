/**
 * Shared utility for running the `message_sending` plugin hook before any
 * outbound message send. This centralizes the hook invocation so that every
 * delivery path (Telegram bot, WhatsApp web, Signal, webchat, etc.) can call
 * it without duplicating hook-runner plumbing.
 *
 * Returns the (possibly modified) text, or `null` if the send was cancelled.
 */
import { getGlobalHookRunner } from "./hook-runner-global.js";

export async function runOutboundMessageHook(params: {
  to: string;
  content: string;
  channel: string;
  accountId?: string;
  metadata?: Record<string, unknown>;
}): Promise<{ content: string } | null> {
  const hookRunner = getGlobalHookRunner();
  if (!hookRunner?.hasHooks("message_sending")) {
    return { content: params.content };
  }

  try {
    const result = await hookRunner.runMessageSending(
      {
        to: params.to,
        content: params.content,
        metadata: { channel: params.channel, ...params.metadata },
      },
      {
        channelId: params.channel,
        accountId: params.accountId,
      },
    );

    if (result?.cancel) {
      return null;
    }
    return { content: result?.content ?? params.content };
  } catch {
    // Never break message delivery because of a plugin error.
    return { content: params.content };
  }
}
