import { hasControlCommand } from "../../auto-reply/command-detection.js";
import {
  createInboundDebouncer,
  resolveInboundDebounceMs,
} from "../../auto-reply/inbound-debounce.js";
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

function resolveSlackSenderId(message: SlackMessageEvent): string | null {
  return message.user ?? message.bot_id ?? null;
}

function isSlackDirectMessageChannel(channelId: string): boolean {
  return channelId.startsWith("D");
}

function isTopLevelSlackMessage(message: SlackMessageEvent): boolean {
  return !message.thread_ts && !message.parent_user_id;
}

function buildTopLevelSlackConversationKey(
  message: SlackMessageEvent,
  accountId: string,
): string | null {
  if (!isTopLevelSlackMessage(message)) {
    return null;
  }
  const senderId = resolveSlackSenderId(message);
  if (!senderId) {
    return null;
  }
  return `slack:${accountId}:${message.channel}:${senderId}`;
}

function shouldDebounceSlackMessage(message: SlackMessageEvent, cfg: SlackMonitorContext["cfg"]) {
  const text = message.text ?? "";
  if (!text.trim()) {
    return false;
  }
  if (message.files && message.files.length > 0) {
    return false;
  }
  const textForCommandDetection = stripSlackMentionsForCommandDetection(text);
  return !hasControlCommand(textForCommandDetection, cfg);
}

/**
 * Build a debounce key that isolates messages by thread (or by message timestamp
 * for top-level non-DM channel messages). Without per-message scoping, concurrent
 * top-level messages from the same sender can share a key and get merged
 * into a single reply on the wrong thread.
 *
 * DMs intentionally stay channel-scoped to preserve short-message batching.
 */
export function buildSlackDebounceKey(
  message: SlackMessageEvent,
  accountId: string,
): string | null {
  const senderId = resolveSlackSenderId(message);
  if (!senderId) {
    return null;
  }
  const messageTs = message.ts ?? message.event_ts;
  const threadKey = message.thread_ts
    ? `${message.channel}:${message.thread_ts}`
    : message.parent_user_id && messageTs
      ? `${message.channel}:maybe-thread:${messageTs}`
      : messageTs && !isSlackDirectMessageChannel(message.channel)
        ? `${message.channel}:${messageTs}`
        : message.channel;
  return `slack:${accountId}:${threadKey}:${senderId}`;
}

export function createSlackMessageHandler(params: {
  ctx: SlackMonitorContext;
  account: ResolvedSlackAccount;
  /** Called on each inbound event to update liveness tracking. */
  trackEvent?: () => void;
}): SlackMessageHandler {
  const { ctx, account, trackEvent } = params;
  const debounceMs = resolveInboundDebounceMs({ cfg: ctx.cfg, channel: "slack" });
  const threadTsResolver = createSlackThreadTsResolver({ client: ctx.app.client });
  const pendingTopLevelDebounceKeys = new Map<string, Set<string>>();

  const debouncer = createInboundDebouncer<{
    message: SlackMessageEvent;
    opts: { source: "message" | "app_mention"; wasMentioned?: boolean };
  }>({
    debounceMs,
    buildKey: (entry) => buildSlackDebounceKey(entry.message, ctx.accountId),
    shouldDebounce: (entry) => shouldDebounceSlackMessage(entry.message, ctx.cfg),
    onFlush: async (entries) => {
      const last = entries.at(-1);
      if (!last) {
        return;
      }
      const flushedKey = buildSlackDebounceKey(last.message, ctx.accountId);
      const topLevelConversationKey = buildTopLevelSlackConversationKey(
        last.message,
        ctx.accountId,
      );
      if (flushedKey && topLevelConversationKey) {
        const pendingKeys = pendingTopLevelDebounceKeys.get(topLevelConversationKey);
        if (pendingKeys) {
          pendingKeys.delete(flushedKey);
          if (pendingKeys.size === 0) {
            pendingTopLevelDebounceKeys.delete(topLevelConversationKey);
          }
        }
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
    if (ctx.markMessageSeen(message.channel, message.ts)) {
      return;
    }
    trackEvent?.();
    const resolvedMessage = await threadTsResolver.resolve({ message, source: opts.source });
    const debounceKey = buildSlackDebounceKey(resolvedMessage, ctx.accountId);
    const conversationKey = buildTopLevelSlackConversationKey(resolvedMessage, ctx.accountId);
    const canDebounce = debounceMs > 0 && shouldDebounceSlackMessage(resolvedMessage, ctx.cfg);
    if (!canDebounce && conversationKey) {
      const pendingKeys = pendingTopLevelDebounceKeys.get(conversationKey);
      if (pendingKeys && pendingKeys.size > 0) {
        const keysToFlush = Array.from(pendingKeys);
        for (const pendingKey of keysToFlush) {
          await debouncer.flushKey(pendingKey);
        }
      }
    }
    if (canDebounce && debounceKey && conversationKey) {
      const pendingKeys = pendingTopLevelDebounceKeys.get(conversationKey) ?? new Set<string>();
      pendingKeys.add(debounceKey);
      pendingTopLevelDebounceKeys.set(conversationKey, pendingKeys);
    }
    await debouncer.enqueue({ message: resolvedMessage, opts });
  };
}
