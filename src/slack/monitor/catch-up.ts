import type { WebClient } from "@slack/web-api";
import type { SlackMessageEvent } from "../types.js";
import type { SlackMessageHandler } from "./message-handler.js";

/**
 * After a socket reconnect, fetch messages that arrived during the disconnect
 * window and replay any that mention the bot. This prevents "missed message"
 * gaps during brief reboots (typically 5-15 seconds).
 */
export async function catchUpMissedMessages(params: {
  client: WebClient;
  botUserId: string;
  disconnectedAt: number;
  handleMessage: SlackMessageHandler;
  log?: (...args: unknown[]) => void;
}): Promise<number> {
  const { client, botUserId, disconnectedAt, handleMessage, log } = params;
  if (!botUserId) {
    return 0;
  }

  const oldest = String(disconnectedAt / 1000);
  let found = 0;

  // Get channels where the bot is a member
  let channelIds: string[] = [];
  try {
    const result = await client.conversations.list({
      types: "public_channel,private_channel,mpim",
      exclude_archived: true,
      limit: 200,
    });
    channelIds = (result.channels ?? []).filter((c) => c.is_member && c.id).map((c) => c.id!);
  } catch (err) {
    log?.(`catch-up: failed to list conversations: ${String(err)}`);
    return 0;
  }

  const mentionTag = `<@${botUserId}>`;

  for (const channelId of channelIds) {
    try {
      const history = await client.conversations.history({
        channel: channelId,
        oldest,
        limit: 50,
        inclusive: true,
      });

      for (const msg of history.messages ?? []) {
        // Skip bot's own messages
        if (msg.user === botUserId || msg.bot_id) {
          continue;
        }
        const mentioned = msg.text?.includes(mentionTag);
        if (!mentioned) {
          continue;
        }

        found++;
        const syntheticEvent: SlackMessageEvent = {
          type: "message",
          user: msg.user,
          text: msg.text ?? "",
          ts: msg.ts,
          thread_ts: msg.thread_ts,
          event_ts: msg.ts,
          channel: channelId,
        };
        try {
          await handleMessage(syntheticEvent, {
            source: "message",
            wasMentioned: true,
          });
        } catch (err) {
          log?.(`catch-up: failed to dispatch message ${msg.ts} in ${channelId}: ${String(err)}`);
        }

        // Also check thread replies if this is a thread root with recent activity
        if (msg.reply_count && msg.reply_count > 0 && msg.ts) {
          try {
            const replies = await client.conversations.replies({
              channel: channelId,
              ts: msg.ts,
              oldest,
              limit: 50,
              inclusive: true,
            });
            for (const reply of replies.messages ?? []) {
              // Skip the root message (already processed) and bot's own
              if (reply.ts === msg.ts || reply.user === botUserId || reply.bot_id) {
                continue;
              }
              if (!reply.text?.includes(mentionTag)) {
                continue;
              }
              found++;
              const replyEvent: SlackMessageEvent = {
                type: "message",
                user: reply.user,
                text: reply.text ?? "",
                ts: reply.ts,
                thread_ts: reply.thread_ts ?? msg.ts,
                event_ts: reply.ts,
                channel: channelId,
              };
              await handleMessage(replyEvent, {
                source: "message",
                wasMentioned: true,
              });
            }
          } catch (err) {
            log?.(
              `catch-up: failed to fetch thread replies for ${msg.ts} in ${channelId}: ${String(err)}`,
            );
          }
        }
      }

      // Also check threads that the bot previously participated in.
      // For threads where the root message is older but new replies mention the bot:
      // conversations.history only returns root messages, so we need to check
      // threads with latest_reply > disconnectedAt.
      for (const msg of history.messages ?? []) {
        if (msg.latest_reply && Number(msg.latest_reply) > disconnectedAt / 1000 && msg.ts) {
          // Already handled threads for messages that mention the bot above.
          // Now check threads where the root doesn't mention bot but replies do.
          if (msg.text?.includes(mentionTag)) {
            continue; // Already processed above
          }
          try {
            const replies = await client.conversations.replies({
              channel: channelId,
              ts: msg.ts,
              oldest,
              limit: 50,
              inclusive: true,
            });
            for (const reply of replies.messages ?? []) {
              if (reply.ts === msg.ts || reply.user === botUserId || reply.bot_id) {
                continue;
              }
              if (!reply.text?.includes(mentionTag)) {
                continue;
              }
              found++;
              const replyEvent: SlackMessageEvent = {
                type: "message",
                user: reply.user,
                text: reply.text ?? "",
                ts: reply.ts,
                thread_ts: reply.thread_ts ?? msg.ts,
                event_ts: reply.ts,
                channel: channelId,
              };
              await handleMessage(replyEvent, {
                source: "message",
                wasMentioned: true,
              });
            }
          } catch (err) {
            log?.(
              `catch-up: failed to fetch thread replies for ${msg.ts} in ${channelId}: ${String(err)}`,
            );
          }
        }
      }
    } catch (err) {
      log?.(`catch-up: failed to fetch history for ${channelId}: ${String(err)}`);
    }
  }

  return found;
}
