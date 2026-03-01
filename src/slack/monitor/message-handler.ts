import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import path from "node:path";
import { hasControlCommand } from "../../auto-reply/command-detection.js";
import {
  createInboundDebouncer,
  resolveInboundDebounceMs,
} from "../../auto-reply/inbound-debounce.js";
import { resolveStateDir } from "../../config/paths.js";
import type { ResolvedSlackAccount } from "../accounts.js";
import type { SlackMessageEvent } from "../types.js";
import { stripSlackMentionsForCommandDetection } from "./commands.js";
import type { SlackMonitorContext } from "./context.js";
import { dispatchPreparedSlackMessage } from "./message-handler/dispatch.js";
import { prepareSlackMessage } from "./message-handler/prepare.js";
import { createSlackThreadTsResolver } from "./thread-resolution.js";

export type SlackMessageHandler = (
  message: SlackMessageEvent,
  opts: { source: "message" | "app_mention"; wasMentioned?: boolean },
) => Promise<void>;

type SlackMessageRepliedEvent = SlackMessageEvent & {
  subtype: "message_replied";
  message?: SlackMessageEvent & { latest_reply?: string };
  hidden?: boolean;
};

export function createSlackMessageHandler(params: {
  ctx: SlackMonitorContext;
  account: ResolvedSlackAccount;
}): SlackMessageHandler {
  const { ctx, account } = params;
  const debounceMs = resolveInboundDebounceMs({ cfg: ctx.cfg, channel: "slack" });
  const threadTsResolver = createSlackThreadTsResolver({ client: ctx.app.client });

  const threadReplyBackfillCursor = loadThreadBackfillCursorStore();
  const threadReplyBackfillInflight = new Map<string, Promise<boolean>>();
  const threadReplyBackfillThrottleUntil = new Map<string, number>();
  const THREAD_REPLY_BACKFILL_THROTTLE_MS = 1_500;
  const slackThreadBackfillLogPath = path.join(
    resolveStateDir(process.env),
    "logs",
    "slack-thread-backfill.log",
  );

  const logThreadBackfill = async (payload: Record<string, unknown>) => {
    try {
      await appendFile(
        slackThreadBackfillLogPath,
        `${JSON.stringify({ ts: new Date().toISOString(), ...payload })}\n`,
        "utf8",
      );
    } catch {
      // best effort
    }
  };

  const debouncer = createInboundDebouncer<{
    message: SlackMessageEvent;
    opts: { source: "message" | "app_mention"; wasMentioned?: boolean };
  }>({
    debounceMs,
    buildKey: (entry) => {
      const senderId = entry.message.user ?? entry.message.bot_id;
      if (!senderId) {
        return null;
      }
      const messageTs = entry.message.ts ?? entry.message.event_ts;
      // If Slack flags a thread reply but omits thread_ts, isolate it from root debouncing.
      const threadKey = entry.message.thread_ts
        ? `${entry.message.channel}:${entry.message.thread_ts}`
        : entry.message.parent_user_id && messageTs
          ? `${entry.message.channel}:maybe-thread:${messageTs}`
          : entry.message.channel;
      return `slack:${ctx.accountId}:${threadKey}:${senderId}`;
    },
    shouldDebounce: (entry) => {
      const text = entry.message.text ?? "";
      if (!text.trim()) {
        return false;
      }
      if (entry.message.files && entry.message.files.length > 0) {
        return false;
      }
      const textForCommandDetection = stripSlackMentionsForCommandDetection(text);
      return !hasControlCommand(textForCommandDetection, ctx.cfg);
    },
    onFlush: async (entries) => {
      const last = entries.at(-1);
      if (!last) {
        return;
      }
      const combinedText =
        entries.length === 1
          ? (last.message.text ?? "")
          : entries
              .map((entry) => entry.message.text ?? "")
              .filter(Boolean)
              .join("\n");
      const combinedMentioned = entries.some((entry) => Boolean(entry.opts.wasMentioned));
      const syntheticMessage: SlackMessageEvent = {
        ...last.message,
        text: combinedText,
      };
      const prepared = await prepareSlackMessage({
        ctx,
        account,
        message: syntheticMessage,
        opts: {
          ...last.opts,
          wasMentioned: combinedMentioned || last.opts.wasMentioned,
        },
      });
      if (!prepared) {
        return;
      }
      if (entries.length > 1) {
        const ids = entries.map((entry) => entry.message.ts).filter(Boolean) as string[];
        if (ids.length > 0) {
          prepared.ctxPayload.MessageSids = ids;
          prepared.ctxPayload.MessageSidFirst = ids[0];
          prepared.ctxPayload.MessageSidLast = ids[ids.length - 1];
        }
      }
      await dispatchPreparedSlackMessage(prepared);
    },
    onError: (err) => {
      ctx.runtime.error?.(`slack inbound debounce flush failed: ${String(err)}`);
    },
  });

  const enqueueSlackInboundMessage = async (
    message: SlackMessageEvent,
    opts: { source: "message" | "app_mention"; wasMentioned?: boolean },
  ) => {
    let normalizedMessage = message;
    const candidate = message as SlackMessageRepliedEvent;
    if (
      opts.source === "message" &&
      candidate.subtype === "message_replied" &&
      candidate.message?.type === "message"
    ) {
      normalizedMessage = {
        ...candidate.message,
        channel: candidate.channel ?? candidate.message.channel,
        event_ts: candidate.event_ts ?? candidate.message.event_ts,
      };
    }

    if (opts.source === "message" && normalizedMessage.type !== "message") {
      return;
    }
    if (
      opts.source === "message" &&
      normalizedMessage.subtype &&
      normalizedMessage.subtype !== "file_share" &&
      normalizedMessage.subtype !== "bot_message"
    ) {
      return;
    }
    if (ctx.markMessageSeen(normalizedMessage.channel, normalizedMessage.ts)) {
      return;
    }
    const resolvedMessage = await threadTsResolver.resolve({
      message: normalizedMessage,
      source: opts.source,
    });
    await debouncer.enqueue({ message: resolvedMessage, opts });
  };

  return async (message, opts) => {
    const candidate = message as SlackMessageRepliedEvent;

    if (
      opts.source === "message" &&
      candidate.subtype === "message_replied" &&
      candidate.message?.thread_ts
    ) {
      const channelId = candidate.channel ?? candidate.message.channel;
      const threadTs = candidate.message.thread_ts;
      if (channelId && threadTs) {
        const cursorKey = `${channelId}:${threadTs}`;
        const now = Date.now();
        const throttleUntil = threadReplyBackfillThrottleUntil.get(cursorKey) ?? 0;
        if (throttleUntil > now || threadReplyBackfillInflight.has(cursorKey)) {
          return;
        }

        const oldest = threadReplyBackfillCursor.get(cursorKey) ?? threadTs;
        const parentMessage = candidate.message;

        const backfillPromise = (async () => {
          threadReplyBackfillThrottleUntil.set(
            cursorKey,
            Date.now() + THREAD_REPLY_BACKFILL_THROTTLE_MS,
          );
          await logThreadBackfill({
            event: "message_replied_parent",
            channel: channelId,
            thread_ts: threadTs,
            ts: candidate.ts,
            event_ts: candidate.event_ts,
            oldest,
          });

          try {
            const replies: SlackMessageEvent[] = [];
            let cursor: string | undefined;
            do {
              const response = (await ctx.app.client.conversations.replies({
                channel: channelId,
                ts: threadTs,
                oldest,
                inclusive: false,
                limit: 200,
                cursor,
              })) as {
                messages?: Array<SlackMessageEvent | null | undefined>;
                response_metadata?: { next_cursor?: string | null };
              };

              const pageReplies = (response.messages ?? []).filter(
                (entry): entry is SlackMessageEvent => {
                  if (!entry) {
                    return false;
                  }
                  return (
                    entry.type === "message" &&
                    Boolean(entry.ts) &&
                    entry.ts !== threadTs &&
                    !entry.subtype
                  );
                },
              );
              replies.push(...pageReplies);
              cursor = response.response_metadata?.next_cursor?.trim() || undefined;
            } while (cursor);

            for (const reply of replies) {
              await enqueueSlackInboundMessage(
                {
                  ...reply,
                  channel: channelId,
                },
                opts,
              );
            }

            const lastTs =
              replies.length > 0
                ? replies[replies.length - 1]?.ts
                : (parentMessage?.latest_reply ?? parentMessage?.ts);
            if (lastTs) {
              threadReplyBackfillCursor.set(cursorKey, lastTs);
              persistThreadBackfillCursorStore(threadReplyBackfillCursor);
            }

            await logThreadBackfill({
              event: "message_replied_backfill",
              channel: channelId,
              thread_ts: threadTs,
              fetched: replies.length,
              oldest,
              newest: lastTs,
            });
            return true;
          } catch (err) {
            ctx.runtime.error?.(
              `slack inbound: message_replied backfill failed channel=${channelId} thread_ts=${threadTs} error=${String(err)}`,
            );
            await logThreadBackfill({
              event: "message_replied_backfill_error",
              channel: channelId,
              thread_ts: threadTs,
              oldest,
              error: String(err),
            });
            return false;
          } finally {
            threadReplyBackfillInflight.delete(cursorKey);
          }
        })();

        threadReplyBackfillInflight.set(cursorKey, backfillPromise);
        const handled = await backfillPromise;
        if (handled) {
          return;
        }
      }
    }

    await enqueueSlackInboundMessage(message, opts);
  };
}

function getThreadBackfillCursorStorePath() {
  return path.join(resolveStateDir(process.env), "state", "slack-thread-backfill-cursors.json");
}

function loadThreadBackfillCursorStore() {
  const map = new Map<string, string>();
  try {
    const filePath = getThreadBackfillCursorStorePath();
    if (!existsSync(filePath)) {
      return map;
    }
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as Record<string, string>;
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "string") {
        map.set(key, value);
      }
    }
  } catch {
    // ignore corrupt/missing store
  }
  return map;
}

let persistThreadBackfillTimer: ReturnType<typeof setTimeout> | undefined;
function persistThreadBackfillCursorStore(store: Map<string, string>) {
  if (persistThreadBackfillTimer) {
    clearTimeout(persistThreadBackfillTimer);
  }
  persistThreadBackfillTimer = setTimeout(() => {
    persistThreadBackfillTimer = undefined;
    try {
      const filePath = getThreadBackfillCursorStorePath();
      mkdirSync(path.dirname(filePath), { recursive: true });
      writeFileSync(filePath, JSON.stringify(Object.fromEntries(store), null, 2), "utf8");
    } catch {
      // best-effort persistence
    }
  }, 100);
}
