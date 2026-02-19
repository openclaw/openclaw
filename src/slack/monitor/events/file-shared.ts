import { appendFileSync } from "node:fs";
import type { SlackMessageEvent } from "../../types.js";
import type { SlackMonitorContext } from "../context.js";
import type { SlackMessageHandler } from "../message-handler.js";
import { danger } from "../../../globals.js";

/**
 * Shared dedup set: the `message` event handler should call
 * `markMessageHandled(ts)` for every message with files so the
 * `file_shared` fallback handler skips them.
 */
const handledMessageTimestamps = new Set<string>();
const DEDUP_TTL_MS = 30_000;
const DIAG_LOG_PATH = "/tmp/diag.log";

function writeDiag(message: string) {
  try {
    appendFileSync(DIAG_LOG_PATH, `${new Date().toISOString()} ${message}\n`);
  } catch {
    // Best-effort diagnostics only.
  }
}

writeDiag("diag init: file-shared.ts loaded");

export function markMessageHandled(ts: string) {
  handledMessageTimestamps.add(ts);
  setTimeout(() => handledMessageTimestamps.delete(ts), DEDUP_TTL_MS);
}

interface FileSharedEvent {
  file_id?: string;
  channel_id?: string;
  user_id?: string;
  event_ts?: string;
}

/**
 * Handle `file_shared` events — Slack's fallback for large file uploads.
 *
 * When a user sends a message with a large file (e.g. PDF > ~20MB), Slack
 * may NOT deliver the normal `message` event via Socket Mode. Instead it
 * only sends a `file_shared` event with { file_id, channel_id, user_id }.
 *
 * This handler catches those events, fetches the actual message from
 * conversations.history, and feeds it into the normal message pipeline.
 */
export function registerSlackFileSharedEvents(params: {
  ctx: SlackMonitorContext;
  handleSlackMessage: SlackMessageHandler;
}) {
  const { ctx, handleSlackMessage } = params;

  // Bolt doesn't type `file_shared` as a known event, so we register via
  // the generic receiver and cast the callback arguments ourselves.
  (
    ctx.app as unknown as {
      event: (name: string, cb: (args: { event: unknown; body: unknown }) => Promise<void>) => void;
    }
  ).event("file_shared", async ({ event, body }) => {
    try {
      const fileEvent = event as FileSharedEvent;
      writeDiag(
        `diag slack file_shared ingress: ch=${fileEvent.channel_id ?? "?"} file=${fileEvent.file_id ?? "?"} user=${fileEvent.user_id ?? "?"} event_ts=${fileEvent.event_ts ?? "?"}`,
      );

      if (ctx.shouldDropMismatchedSlackEvent(body)) {
        writeDiag(
          `diag slack file_shared drop(mismatch): ch=${fileEvent.channel_id ?? "?"} file=${fileEvent.file_id ?? "?"}`,
        );
        return;
      }

      const channelId = fileEvent.channel_id;
      const fileId = fileEvent.file_id;
      if (!channelId || !fileId) {
        writeDiag("diag slack file_shared drop(missing channel or file id)");
        return;
      }

      // Skip if the bot itself shared the file
      if (fileEvent.user_id === ctx.botUserId) {
        writeDiag(`diag slack file_shared drop(bot user): ch=${channelId} file=${fileId}`);
        return;
      }

      // Small delay — give Slack time to settle the message so
      // conversations.history returns it with the full files array.
      await new Promise((r) => setTimeout(r, 2000));

      // Fetch the most recent messages in the channel
      const result = await ctx.app.client.conversations.history({
        channel: channelId,
        limit: 5,
      });

      if (!result.ok || !result.messages?.length) {
        writeDiag(`diag slack file_shared history empty: ch=${channelId} file=${fileId}`);
        return;
      }

      // Find the message that contains our file_id
      const matchingMessage = result.messages.find((msg) =>
        (msg as Record<string, unknown>).files
          ? ((msg as Record<string, unknown>).files as Array<{ id?: string }>)?.some(
              (f) => f.id === fileId,
            )
          : false,
      );

      if (!matchingMessage) {
        writeDiag(
          `diag slack file_shared no matching message in history: ch=${channelId} file=${fileId}`,
        );
        return;
      }

      // Dedup: skip if we already handled this message via the normal
      // `message` event (small files get both events).
      const msgTs = matchingMessage.ts;
      if (msgTs && handledMessageTimestamps.has(msgTs)) {
        writeDiag(
          `diag slack file_shared skipped duplicate message ${msgTs} in ${channelId} (file ${fileId})`,
        );
        ctx.runtime.log?.(
          `file_shared fallback: skipped duplicate message ${msgTs} in ${channelId} (file ${fileId})`,
        );
        return;
      }

      // Skip bot messages
      if (matchingMessage.bot_id || matchingMessage.user === ctx.botUserId) {
        writeDiag(
          `diag slack file_shared drop(bot message): ch=${channelId} file=${fileId} ts=${matchingMessage.ts ?? "?"}`,
        );
        return;
      }

      // Mark as handled (prevent future duplicates within this handler)
      if (msgTs) {
        markMessageHandled(msgTs);
      }

      // Resolve channel type for the message event
      const channelInfo = await ctx.resolveChannelName(channelId);

      // Build a SlackMessageEvent from the history response
      const files = (matchingMessage as Record<string, unknown>)
        .files as SlackMessageEvent["files"];
      const message: SlackMessageEvent = {
        type: "message",
        user: matchingMessage.user,
        text: matchingMessage.text ?? "",
        ts: matchingMessage.ts,
        thread_ts: matchingMessage.thread_ts,
        event_ts: fileEvent.event_ts,
        channel: channelId,
        channel_type: channelInfo?.type,
        files,
        subtype: "file_share",
      };

      ctx.runtime.log?.(
        `file_shared fallback: processing message ${msgTs} in ${channelId} (file ${fileId})`,
      );
      writeDiag(
        `diag slack file_shared processing message ${msgTs ?? "?"} in ${channelId} (file ${fileId})`,
      );

      writeDiag(
        `diag slack file_shared calling handleSlackMessage: ch=${channelId} ts=${msgTs ?? "?"} file=${fileId} files=${message.files?.length ?? 0} text_len=${(message.text ?? "").length}`,
      );
      await handleSlackMessage(message, { source: "file_shared" });
      writeDiag(
        `diag slack file_shared handleSlackMessage returned: ch=${channelId} ts=${msgTs ?? "?"} file=${fileId}`,
      );
    } catch (err) {
      writeDiag(`diag slack file_shared handler exception: ${String(err)}`);
      ctx.runtime.error?.(danger(`slack file_shared handler failed: ${String(err)}`));
    }
  });
}
