import {
  createChannelInboundDebouncer,
  shouldFlushDirectTextInbound,
  shouldDebounceTextInbound,
} from "../../channels/inbound-debounce-policy.js";
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

type SlackInboundEntry = {
  message: SlackMessageEvent;
  opts: { source: "message" | "app_mention"; wasMentioned?: boolean };
};

const APP_MENTION_RETRY_TTL_MS = 60_000;
export const MAX_PENDING_TOP_LEVEL_IMMEDIATE_ENTRIES_PER_CONVERSATION = 50;
export const MAX_PENDING_TOP_LEVEL_IMMEDIATE_ENTRIES_TOTAL = 100;
const PENDING_TOP_LEVEL_IMMEDIATE_OVERFLOW_LOG_COOLDOWN_MS = 10_000;

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
  const textForCommandDetection = stripSlackMentionsForCommandDetection(text);
  return shouldDebounceTextInbound({
    text: textForCommandDetection,
    cfg,
    hasMedia: Boolean(message.files && message.files.length > 0),
  });
}

function shouldFlushDirectSlackMessage(
  message: SlackMessageEvent,
  cfg: SlackMonitorContext["cfg"],
): boolean {
  return shouldFlushDirectTextInbound({
    text: stripSlackMentionsForCommandDetection(message.text ?? ""),
    cfg,
    requiresDirectFlush: Boolean(message.files && message.files.length > 0),
  });
}

function buildSeenMessageKey(channelId: string | undefined, ts: string | undefined): string | null {
  if (!channelId || !ts) {
    return null;
  }
  return `${channelId}:${ts}`;
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
  const pendingTopLevelDebounceKeys = new Map<string, Set<string>>();
  const pendingTopLevelImmediateEntries = new Map<string, SlackInboundEntry[]>();
  const pendingTopLevelImmediateOverflowLogAt = new Map<string, number>();
  const drainingTopLevelImmediateEntries = new Set<string>();
  let totalPendingTopLevelImmediateEntries = 0;
  let debouncer!: ReturnType<typeof createChannelInboundDebouncer<SlackInboundEntry>>["debouncer"];

  const releaseTopLevelPendingKey = (entry: SlackInboundEntry): string | null => {
    const flushedKey = buildSlackDebounceKey(entry.message, ctx.accountId);
    const conversationKey = buildTopLevelSlackConversationKey(entry.message, ctx.accountId);
    if (!flushedKey || !conversationKey) {
      return null;
    }
    const pendingKeys = pendingTopLevelDebounceKeys.get(conversationKey);
    if (!pendingKeys) {
      return null;
    }
    pendingKeys.delete(flushedKey);
    if (pendingKeys.size > 0) {
      return null;
    }
    pendingTopLevelDebounceKeys.delete(conversationKey);
    return conversationKey;
  };

  const logImmediateOverflow = (conversationKey: string) => {
    const now = Date.now();
    const lastLogAt = pendingTopLevelImmediateOverflowLogAt.get(conversationKey) ?? 0;
    if (now - lastLogAt < PENDING_TOP_LEVEL_IMMEDIATE_OVERFLOW_LOG_COOLDOWN_MS) {
      return;
    }
    pendingTopLevelImmediateOverflowLogAt.set(conversationKey, now);
    ctx.runtime.error?.(
      "slack inbound immediate backlog overflow; bypassing queue to cap memory growth",
    );
  };

  const queueTopLevelImmediateEntry = (conversationKey: string, entry: SlackInboundEntry) => {
    const queuedEntries = pendingTopLevelImmediateEntries.get(conversationKey) ?? [];
    if (
      queuedEntries.length >= MAX_PENDING_TOP_LEVEL_IMMEDIATE_ENTRIES_PER_CONVERSATION ||
      totalPendingTopLevelImmediateEntries >= MAX_PENDING_TOP_LEVEL_IMMEDIATE_ENTRIES_TOTAL
    ) {
      logImmediateOverflow(conversationKey);
      return false;
    }
    queuedEntries.push(entry);
    pendingTopLevelImmediateEntries.set(conversationKey, queuedEntries);
    totalPendingTopLevelImmediateEntries += 1;
    return true;
  };

  const shiftTopLevelImmediateEntry = (conversationKey: string) => {
    const queuedEntries = pendingTopLevelImmediateEntries.get(conversationKey);
    if (!queuedEntries) {
      return null;
    }
    const nextEntry = queuedEntries.shift();
    if (!nextEntry) {
      pendingTopLevelImmediateEntries.delete(conversationKey);
      pendingTopLevelImmediateOverflowLogAt.delete(conversationKey);
      return null;
    }
    totalPendingTopLevelImmediateEntries = Math.max(0, totalPendingTopLevelImmediateEntries - 1);
    if (queuedEntries.length === 0) {
      pendingTopLevelImmediateEntries.delete(conversationKey);
      pendingTopLevelImmediateOverflowLogAt.delete(conversationKey);
    }
    return nextEntry;
  };

  const drainTopLevelImmediateEntries = async (conversationKey: string) => {
    if (drainingTopLevelImmediateEntries.has(conversationKey)) {
      return;
    }
    if ((pendingTopLevelDebounceKeys.get(conversationKey)?.size ?? 0) > 0) {
      return;
    }
    if ((pendingTopLevelImmediateEntries.get(conversationKey)?.length ?? 0) === 0) {
      return;
    }
    drainingTopLevelImmediateEntries.add(conversationKey);
    try {
      while ((pendingTopLevelDebounceKeys.get(conversationKey)?.size ?? 0) === 0) {
        const nextEntry = shiftTopLevelImmediateEntry(conversationKey);
        if (!nextEntry) {
          return;
        }
        await debouncer.enqueue(nextEntry);
      }
    } finally {
      drainingTopLevelImmediateEntries.delete(conversationKey);
    }
  };

  const { debounceMs, debouncer: createdDebouncer } =
    createChannelInboundDebouncer<SlackInboundEntry>({
      cfg: ctx.cfg,
      channel: "slack",
      buildKey: (entry) => buildSlackDebounceKey(entry.message, ctx.accountId),
      shouldDebounce: (entry) => shouldDebounceSlackMessage(entry.message, ctx.cfg),
      shouldFlushDirectWhenPending: (entry) =>
        shouldFlushDirectSlackMessage(entry.message, ctx.cfg),
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
        const seenMessageKey = buildSeenMessageKey(last.message.channel, last.message.ts);
        if (!prepared) {
          const conversationKeyToDrain = releaseTopLevelPendingKey(last);
          if (conversationKeyToDrain) {
            await drainTopLevelImmediateEntries(conversationKeyToDrain);
          }
          return;
        }
        if (seenMessageKey) {
          pruneAppMentionRetryKeys(Date.now());
          if (last.opts.source === "app_mention") {
            // If app_mention wins the race and dispatches first, drop the later message dispatch.
            appMentionDispatchedKeys.set(seenMessageKey, Date.now() + APP_MENTION_RETRY_TTL_MS);
          } else if (
            last.opts.source === "message" &&
            appMentionDispatchedKeys.has(seenMessageKey)
          ) {
            appMentionDispatchedKeys.delete(seenMessageKey);
            appMentionRetryKeys.delete(seenMessageKey);
            const conversationKeyToDrain = releaseTopLevelPendingKey(last);
            if (conversationKeyToDrain) {
              await drainTopLevelImmediateEntries(conversationKeyToDrain);
            }
            return;
          }
          appMentionRetryKeys.delete(seenMessageKey);
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
        const conversationKeyToDrain = releaseTopLevelPendingKey(last);
        if (conversationKeyToDrain) {
          await drainTopLevelImmediateEntries(conversationKeyToDrain);
        }
      },
      onError: (err, entries) => {
        ctx.runtime.error?.(`slack inbound debounce flush failed: ${String(err)}`);
        if ((err as { code?: string }).code !== "INBOUND_DEBOUNCE_MAX_RETRIES_EXCEEDED") {
          return;
        }
        const last = entries.at(-1);
        if (!last) {
          return;
        }
        const conversationKeyToDrain = releaseTopLevelPendingKey(last);
        if (conversationKeyToDrain) {
          void drainTopLevelImmediateEntries(conversationKeyToDrain);
        }
      },
    });
  debouncer = createdDebouncer;
  const threadTsResolver = createSlackThreadTsResolver({ client: ctx.app.client });
  const appMentionRetryKeys = new Map<string, number>();
  const appMentionDispatchedKeys = new Map<string, number>();

  const pruneAppMentionRetryKeys = (now: number) => {
    for (const [key, expiresAt] of appMentionRetryKeys) {
      if (expiresAt <= now) {
        appMentionRetryKeys.delete(key);
      }
    }
    for (const [key, expiresAt] of appMentionDispatchedKeys) {
      if (expiresAt <= now) {
        appMentionDispatchedKeys.delete(key);
      }
    }
  };

  const rememberAppMentionRetryKey = (key: string) => {
    const now = Date.now();
    pruneAppMentionRetryKeys(now);
    appMentionRetryKeys.set(key, now + APP_MENTION_RETRY_TTL_MS);
  };

  const consumeAppMentionRetryKey = (key: string) => {
    const now = Date.now();
    pruneAppMentionRetryKeys(now);
    if (!appMentionRetryKeys.has(key)) {
      return false;
    }
    appMentionRetryKeys.delete(key);
    return true;
  };

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
    const seenMessageKey = buildSeenMessageKey(message.channel, message.ts);
    const wasSeen = seenMessageKey ? ctx.markMessageSeen(message.channel, message.ts) : false;
    if (seenMessageKey && opts.source === "message" && !wasSeen) {
      // Prime exactly one fallback app_mention allowance immediately so a near-simultaneous
      // app_mention is not dropped while message handling is still in-flight.
      rememberAppMentionRetryKey(seenMessageKey);
    }
    if (seenMessageKey && wasSeen) {
      // Allow exactly one app_mention retry if the same ts was previously dropped
      // from the message stream before it reached dispatch.
      if (opts.source !== "app_mention" || !consumeAppMentionRetryKey(seenMessageKey)) {
        return;
      }
    }
    trackEvent?.();
    const resolvedMessage = await threadTsResolver.resolve({ message, source: opts.source });
    const debounceKey = buildSlackDebounceKey(resolvedMessage, ctx.accountId);
    const conversationKey = buildTopLevelSlackConversationKey(resolvedMessage, ctx.accountId);
    const canDebounce = debounceMs > 0 && shouldDebounceSlackMessage(resolvedMessage, ctx.cfg);
    const shouldFlushDirect = shouldFlushDirectSlackMessage(resolvedMessage, ctx.cfg);
    if (!canDebounce && conversationKey) {
      const pendingKeys = pendingTopLevelDebounceKeys.get(conversationKey);
      if (pendingKeys && pendingKeys.size > 0) {
        const keysToFlush = Array.from(pendingKeys);
        let waitingOnPendingKeys = false;
        for (const pendingKey of keysToFlush) {
          waitingOnPendingKeys ||= !(await debouncer.flushKey(pendingKey));
        }
        if (waitingOnPendingKeys) {
          if (shouldFlushDirect) {
            await debouncer.enqueue({ message: resolvedMessage, opts });
            return;
          }
          // Keep immediate top-level followers behind older buffered keys until those keys resolve.
          if (queueTopLevelImmediateEntry(conversationKey, { message: resolvedMessage, opts })) {
            return;
          }
          // Once the backlog cap is hit, bypass the queue so pending memory stays bounded.
          await debouncer.enqueue({ message: resolvedMessage, opts });
          return;
        }
      }
    }
    if (canDebounce && debounceKey && conversationKey) {
      const pendingKeys = pendingTopLevelDebounceKeys.get(conversationKey) ?? new Set<string>();
      pendingKeys.add(debounceKey);
      pendingTopLevelDebounceKeys.set(conversationKey, pendingKeys);
    }
    const remainsPending = await debouncer.enqueue({ message: resolvedMessage, opts });
    if (canDebounce && debounceKey && conversationKey && !remainsPending) {
      const conversationKeyToDrain = releaseTopLevelPendingKey({ message: resolvedMessage, opts });
      if (conversationKeyToDrain) {
        await drainTopLevelImmediateEntries(conversationKeyToDrain);
      }
    }
  };
}
