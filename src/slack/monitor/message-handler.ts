import type { ResolvedSlackAccount } from "../accounts.js";
import type { SlackMessageEvent } from "../types.js";
import type { SlackMonitorContext } from "./context.js";
import { hasControlCommand } from "../../auto-reply/command-detection.js";
import {
  createInboundDebouncer,
  resolveInboundDebounceMs,
} from "../../auto-reply/inbound-debounce.js";
import { writeSlackDiagKv } from "./diag.js";
import { dispatchPreparedSlackMessage } from "./message-handler/dispatch.js";
import { prepareSlackMessage } from "./message-handler/prepare.js";
import { createSlackThreadTsResolver } from "./thread-resolution.js";

export type SlackMessageHandler = (
  message: SlackMessageEvent,
  opts: { source: "message" | "app_mention" | "file_shared"; wasMentioned?: boolean },
) => Promise<void>;

export function createSlackMessageHandler(params: {
  ctx: SlackMonitorContext;
  account: ResolvedSlackAccount;
}): SlackMessageHandler {
  const { ctx, account } = params;
  const debounceMs = resolveInboundDebounceMs({ cfg: ctx.cfg, channel: "slack" });
  const threadTsResolver = createSlackThreadTsResolver({ client: ctx.app.client });

  const debouncer = createInboundDebouncer<{
    message: SlackMessageEvent;
    opts: { source: "message" | "app_mention" | "file_shared"; wasMentioned?: boolean };
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
      return !hasControlCommand(text, ctx.cfg);
    },
    onFlush: async (entries) => {
      const last = entries.at(-1);
      if (!last) {
        return;
      }
      writeSlackDiagKv("diag slack handler onFlush start", {
        source: last.opts.source,
        ch: last.message.channel ?? "?",
        ts: last.message.ts ?? last.message.event_ts ?? "?",
        entries: entries.length,
      });
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
        writeSlackDiagKv("diag slack handler onFlush prepared=null", {
          source: last.opts.source,
          ch: syntheticMessage.channel ?? "?",
          ts: syntheticMessage.ts ?? syntheticMessage.event_ts ?? "?",
          files: syntheticMessage.files?.length ?? 0,
          text_len: (syntheticMessage.text ?? "").length,
        });
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
      writeSlackDiagKv("diag slack handler dispatch start", {
        source: last.opts.source,
        ch: syntheticMessage.channel ?? "?",
        ts: syntheticMessage.ts ?? syntheticMessage.event_ts ?? "?",
      });
      await dispatchPreparedSlackMessage(prepared);
      writeSlackDiagKv("diag slack handler dispatch done", {
        source: last.opts.source,
        ch: syntheticMessage.channel ?? "?",
        ts: syntheticMessage.ts ?? syntheticMessage.event_ts ?? "?",
      });
    },
    onError: (err) => {
      ctx.runtime.error?.(`slack inbound debounce flush failed: ${String(err)}`);
    },
  });

  return async (message, opts) => {
    writeSlackDiagKv("diag slack handler enter", {
      source: opts.source,
      ch: message.channel ?? "?",
      ts: message.ts ?? message.event_ts ?? "?",
      subtype: message.subtype ?? "-",
      files: message.files?.length ?? 0,
    });
    if (opts.source === "message" && message.type !== "message") {
      writeSlackDiagKv("diag slack handler drop(non-message type)", {
        source: opts.source,
        ch: message.channel ?? "?",
        ts: message.ts ?? message.event_ts ?? "?",
        type: message.type,
      });
      return;
    }
    if (
      opts.source === "message" &&
      message.subtype &&
      message.subtype !== "file_share" &&
      message.subtype !== "bot_message"
    ) {
      writeSlackDiagKv("diag slack handler drop(subtype)", {
        source: opts.source,
        ch: message.channel ?? "?",
        ts: message.ts ?? message.event_ts ?? "?",
        subtype: message.subtype ?? "-",
      });
      return;
    }
    // Let file_shared fallback re-enter even when ts was already seen via the
    // lightweight event that didn't produce a message turn.
    if (opts.source !== "file_shared" && ctx.markMessageSeen(message.channel, message.ts)) {
      writeSlackDiagKv("diag slack handler drop(seen)", {
        source: opts.source,
        ch: message.channel ?? "?",
        ts: message.ts ?? message.event_ts ?? "?",
      });
      return;
    }
    const resolvedMessage = await threadTsResolver.resolve({ message, source: opts.source });
    writeSlackDiagKv("diag slack handler enqueue", {
      source: opts.source,
      ch: resolvedMessage.channel ?? "?",
      ts: resolvedMessage.ts ?? resolvedMessage.event_ts ?? "?",
      files: resolvedMessage.files?.length ?? 0,
    });
    await debouncer.enqueue({ message: resolvedMessage, opts });
  };
}
