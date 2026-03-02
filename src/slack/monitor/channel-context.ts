/**
 * Fetches recent messages from a Slack channel and formats them as context
 * for injection into AI Assistant thread conversations.
 *
 * When a user opens the assistant side panel while viewing a channel, we can
 * fetch that channel's recent messages and include them so the agent can
 * answer questions like "summarize this channel" or "what's the team discussing?".
 */

import type { WebClient } from "@slack/web-api";
import { logVerbose } from "../../globals.js";
import { readSlackMessages, type SlackActionClientOpts } from "../actions.js";

/** Default number of recent messages to fetch. */
const DEFAULT_MESSAGE_LIMIT = 20;

/** Timeout for the channel message fetch (ms). */
const FETCH_TIMEOUT_MS = 8_000;

export type ChannelContextOptions = {
  /** The channel to fetch messages from (the one the user is currently viewing). */
  channelId: string;
  /** Slack client options for making API calls. */
  clientOpts: SlackActionClientOpts;
  /** WebClient instance for channel info resolution. */
  client: WebClient;
  /** Max number of messages to fetch. */
  messageLimit?: number;
};

export type ChannelContextResult = {
  /** Formatted context string ready for injection into the system prompt. */
  contextBlock: string;
  /** Channel name (if resolved). */
  channelName?: string;
  /** Number of messages included. */
  messageCount: number;
};

/**
 * Format a Slack timestamp into a relative time string.
 */
function formatRelativeTime(ts: string): string {
  const messageTime = Number(ts) * 1000;
  const now = Date.now();
  const diffMs = now - messageTime;
  const diffMin = Math.round(diffMs / 60_000);

  if (diffMin < 1) {
    return "just now";
  }
  if (diffMin < 60) {
    return `${diffMin}m ago`;
  }
  const diffHours = Math.round(diffMin / 60);
  if (diffHours < 24) {
    return `${diffHours}h ago`;
  }
  const diffDays = Math.round(diffHours / 24);
  return `${diffDays}d ago`;
}

/**
 * Resolve a channel name from the Slack API.
 * Returns undefined if resolution fails.
 */
async function resolveChannelName(
  client: WebClient,
  channelId: string,
): Promise<string | undefined> {
  try {
    const result = await client.conversations.info({ channel: channelId });
    return (result.channel as { name?: string })?.name ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * Fetch recent messages from a channel and format them as a context block.
 *
 * Returns `null` if the fetch fails or returns no messages. Errors are logged
 * but never thrown — this is a best-effort enhancement that must not block
 * message processing.
 */
export async function fetchChannelContext(
  opts: ChannelContextOptions,
): Promise<ChannelContextResult | null> {
  const { channelId, clientOpts, client } = opts;
  const limit = opts.messageLimit ?? DEFAULT_MESSAGE_LIMIT;

  try {
    // Race the fetch against a timeout so we don't block message processing.
    const result = await Promise.race([
      readSlackMessages(channelId, { ...clientOpts, limit }),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), FETCH_TIMEOUT_MS)),
    ]);

    if (!result || result.messages.length === 0) {
      logVerbose(`slack channel context: no messages found for ${channelId}`);
      return null;
    }

    // Resolve channel name in parallel (best-effort).
    const channelName = await resolveChannelName(client, channelId);

    // Messages come in reverse chronological order (newest first) from conversations.history.
    // Reverse so they read top-to-bottom chronologically.
    const messages = (result.messages ?? []).toReversed();

    const lines: string[] = [];
    for (const msg of messages) {
      if (!msg.text?.trim()) {
        continue;
      }
      const userLabel = msg.user ? `<@${msg.user}>` : "unknown";
      const timeLabel = msg.ts ? formatRelativeTime(msg.ts) : "";
      const timeStr = timeLabel ? ` (${timeLabel})` : "";
      lines.push(`- ${userLabel}${timeStr}: ${msg.text.trim()}`);
    }

    if (lines.length === 0) {
      return null;
    }

    const channelLabel = channelName ? `#${channelName}` : channelId;
    const contextBlock = [
      `[Channel Context] The user is currently viewing ${channelLabel}. Here are the recent messages:`,
      ...lines,
    ].join("\n");

    return {
      contextBlock,
      channelName,
      messageCount: lines.length,
    };
  } catch (err) {
    logVerbose(`slack channel context: failed to fetch messages for ${channelId}: ${String(err)}`);
    return null;
  }
}
