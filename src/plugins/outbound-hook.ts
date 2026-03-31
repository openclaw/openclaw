/**
 * Shared utility for running the `message_sending` plugin hook from channel dispatchers.
 *
 * Returns `null` if the hook cancels the message, or `{ content }` with
 * (possibly modified) content to send. Swallows hook errors so plugin bugs
 * never break message delivery.
 */

import { getGlobalHookRunner, hasGlobalHooks } from "./hook-runner-global.js";

export async function runOutboundMessageHook(params: {
  to: string;
  content: string;
  channel: string;
  accountId?: string;
}): Promise<{ content: string } | null> {
  if (!hasGlobalHooks("message_sending")) {
    return { content: params.content };
  }
  const hookRunner = getGlobalHookRunner();
  if (!hookRunner) {
    return { content: params.content };
  }
  try {
    const result = await hookRunner.runMessageSending(
      {
        to: params.to,
        content: params.content,
        metadata: {
          channel: params.channel,
          accountId: params.accountId,
        },
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
    // Don't block delivery on hook failure.
    return { content: params.content };
  }
}
