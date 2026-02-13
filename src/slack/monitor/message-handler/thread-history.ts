/**
 * Thread history utilities for persistent thread sessions.
 *
 * When a thread reply targets a dead/completed subagent session, we fetch
 * the thread history to provide context to the revival session.
 */

import type { WebClient } from "@slack/web-api";

/**
 * Fetch and format thread history for revival context.
 *
 * Returns a formatted string with thread messages, or `undefined` if unable to fetch.
 */
export async function fetchThreadHistoryForRevival(params: {
  channelId: string;
  threadTs: string;
  client: WebClient;
  botUserId?: string;
  limit?: number;
}): Promise<string | undefined> {
  const { channelId, threadTs, client, botUserId, limit = 20 } = params;

  try {
    const result = await client.conversations.replies({
      channel: channelId,
      ts: threadTs,
      limit,
    });

    if (!result.messages?.length) {
      return undefined;
    }

    // Format messages for context injection
    const formatted = result.messages
      .map((msg) => {
        const sender = msg.user === botUserId ? "Agent" : (msg.user ?? "Unknown");
        const text = (msg.text ?? "").trim();
        if (!text) {
          return null;
        }
        return `[${sender}]: ${text}`;
      })
      .filter((line): line is string => line !== null)
      .join("\n");

    if (!formatted) {
      return undefined;
    }

    return `--- Thread History ---\n${formatted}\n--- End Thread History ---`;
  } catch (_error) {
    // Silently fail — revival will proceed without history if fetch fails
    return undefined;
  }
}
