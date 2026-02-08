import type { ResolvedSlackAccount } from "../accounts.js";
import type { SlackMessageEvent } from "../types.js";
import type { SlackMonitorContext } from "./context.js";
import { hasControlCommand } from "../../auto-reply/command-detection.js";
import {
  createInboundDebouncer,
  resolveInboundDebounceMs,
} from "../../auto-reply/inbound-debounce.js";
import { dispatchPreparedSlackMessage } from "./message-handler/dispatch.js";
import { prepareSlackMessage } from "./message-handler/prepare.js";
import { createSlackThreadTsResolver } from "./thread-resolution.js";

export type SlackMessageHandler = (
  message: SlackMessageEvent,
  opts: { source: "message" | "app_mention"; wasMentioned?: boolean },
) => Promise<void>;

type SlackInboundEntry = {
  message: SlackMessageEvent;
  opts: { source: "message" | "app_mention"; wasMentioned?: boolean };
};

export function dedupeSlackInboundEntries(entries: SlackInboundEntry[]): SlackInboundEntry[] {
  if (entries.length <= 1) {
    return entries;
  }

  const deduped: SlackInboundEntry[] = [];
  const indexByTs = new Map<string, number>();

  for (const entry of entries) {
    const ts = entry.message.ts ?? entry.message.event_ts;
    if (!ts) {
      deduped.push(entry);
      continue;
    }
    const existingIndex = indexByTs.get(ts);
    if (existingIndex === undefined) {
      indexByTs.set(ts, deduped.length);
      deduped.push(entry);
      continue;
    }
    const existing = deduped[existingIndex];
    const existingMentioned = Boolean(existing.opts.wasMentioned);
    const currentMentioned = Boolean(entry.opts.wasMentioned);
    if (!existingMentioned && currentMentioned) {
      deduped[existingIndex] = entry;
    }
  }

  return deduped;
}

export function createSlackMessageHandler(params: {
  ctx: SlackMonitorContext;
  account: ResolvedSlackAccount;
}): SlackMessageHandler {
  const { ctx, account } = params;
  const debounceMs = resolveInboundDebounceMs({ cfg: ctx.cfg, channel: "slack" });
  const threadTsResolver = createSlackThreadTsResolver({ client: ctx.app.client });

  const debouncer = createInboundDebouncer<SlackInboundEntry>({
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
      const deduped = dedupeSlackInboundEntries(entries);
      const last = deduped.at(-1);
      if (!last) {
        return;
      }
      const combinedText =
        deduped.length === 1
          ? (last.message.text ?? "")
          : deduped
              .map((entry) => entry.message.text ?? "")
              .filter(Boolean)
              .join("\n");
      const combinedMentioned = deduped.some((entry) => Boolean(entry.opts.wasMentioned));
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
      if (deduped.length > 1) {
        const ids = deduped.map((entry) => entry.message.ts).filter(Boolean) as string[];
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

  return async (message, opts) => {
    if (opts.source === "message" && message.type !== "message") {
      return;
    }
    if (
      opts.source === "message" &&
      message.subtype &&
      message.subtype !== "file_share" &&
      message.subtype !== "bot_message"
    ) {
      return;
    }
    const resolvedMessage = await threadTsResolver.resolve({ message, source: opts.source });
    await debouncer.enqueue({ message: resolvedMessage, opts });
  };
}
