/**
 * Pre-sequentialize contextual activation gate for Telegram groups.
 *
 * Runs the decision model **concurrently** (before grammY's `sequentialize`
 * middleware) so that peeking/skip decisions are not blocked by an ongoing
 * main-model response in the same chat.
 *
 * Messages that the decision model decides to skip are recorded in group
 * history and short-circuited here — they never enter the sequential queue.
 * Messages that should be processed are tagged with a pre-gate result so
 * that `buildTelegramMessageContext` can reuse the decision without calling
 * the model a second time.
 */

import { resolveDefaultAgentId } from "../agents/agent-scope.js";
import {
  engagementStates,
  shouldParticipateInGroup,
  type ContextualActivationConfig,
} from "../auto-reply/contextual-activation.js";
import {
  recordPendingHistoryEntryIfEnabled,
  type HistoryEntry,
} from "../auto-reply/reply/history.js";
import { buildMentionRegexes } from "../auto-reply/reply/mentions.js";
import type { OpenClawConfig } from "../config/config.js";
import type { TelegramGroupConfig } from "../config/types.js";
import { logVerbose } from "../globals.js";
import { resolveMedia } from "./bot/delivery.js";
import {
  buildTelegramGroupPeerId,
  hasBotMention,
  resolveTelegramForumThreadId,
} from "./bot/helpers.js";
import { getTelegramSequentialKey } from "./sequential-key.js";
import { getCachedSticker } from "./sticker-cache.js";

// ---------------------------------------------------------------------------
// Pre-gate result — attached to ctx for downstream consumption
// ---------------------------------------------------------------------------

export type PreGateResult = {
  shouldProcess: true;
  hint?: string;
};

const preGateResults = new WeakMap<object, PreGateResult>();

export function getPreGateResult(ctx: object): PreGateResult | undefined {
  return preGateResults.get(ctx);
}

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

type ResolveTelegramGroupConfig = (
  chatId: string | number,
  messageThreadId?: number,
) => {
  groupConfig?: TelegramGroupConfig | Record<string, unknown>;
  topicConfig?: Record<string, unknown>;
};

export type ContextualPreGateDeps = {
  cfg: OpenClawConfig;
  groupHistories: Map<string, HistoryEntry[]>;
  historyLimit: number;
  latestGroupMessageIds: Map<string, number>;
  resolveTelegramGroupConfig: ResolveTelegramGroupConfig;
  resolveGroupRequireMention: (chatId: string | number) => boolean;
  resolveGroupActivation: (params: {
    chatId: string | number;
    messageThreadId?: number;
  }) => boolean | undefined;
  token: string;
  mediaMaxBytes: number;
  proxyFetch?: typeof fetch;
};

// ---------------------------------------------------------------------------
// Simple media placeholder for messages with no text
// ---------------------------------------------------------------------------

// oxlint-disable-next-line typescript/no-explicit-any
function resolvePlaceholder(msg: any): string {
  if (msg.photo) {
    return "[image]";
  }
  if (msg.video) {
    return "[video]";
  }
  if (msg.voice || msg.audio) {
    return "[voice message]";
  }
  if (msg.sticker) {
    const emoji = msg.sticker.emoji ?? "";
    const setName = msg.sticker.set_name;
    // Try to resolve a human-readable description from the sticker cache
    const cached = msg.sticker.file_unique_id ? getCachedSticker(msg.sticker.file_unique_id) : null;
    if (cached?.description) {
      const ctx = [emoji, setName ? `from "${setName}"` : null].filter(Boolean).join(" ");
      return `[sticker${ctx ? ` ${ctx}` : ""}] ${cached.description}`;
    }
    return `[sticker${emoji ? ` ${emoji}` : ""}${setName ? ` from "${setName}"` : ""}]`;
  }
  if (msg.document) {
    return `[file: ${msg.document.file_name ?? "unknown"}]`;
  }
  if (msg.animation) {
    return "[GIF]";
  }
  return "";
}

// ---------------------------------------------------------------------------
// Middleware factory
// ---------------------------------------------------------------------------

export function createContextualPreGate(deps: ContextualPreGateDeps) {
  // Cache mention regexes once (they don't change at runtime).
  let cachedMentionRegexes: RegExp[] | undefined;

  // oxlint-disable-next-line typescript/no-explicit-any
  return async (ctx: any, next: () => Promise<void>) => {
    const msg = ctx.message ?? ctx.channelPost;
    if (!msg?.chat) {
      return next();
    }

    const chatId = msg.chat.id;
    const isGroup = msg.chat.type === "group" || msg.chat.type === "supergroup";
    if (!isGroup) {
      return next();
    }

    const isForum = msg.chat.is_forum === true;
    const messageThreadId = msg.message_thread_id as number | undefined;
    const resolvedThreadId = resolveTelegramForumThreadId({ isForum, messageThreadId });
    const { groupConfig } = deps.resolveTelegramGroupConfig(chatId, resolvedThreadId);
    const contextualConfig = (groupConfig as TelegramGroupConfig | undefined)
      ?.contextualActivation as ContextualActivationConfig | undefined;
    if (!contextualConfig?.model) {
      return next();
    }

    const groupKey = buildTelegramGroupPeerId(chatId, resolvedThreadId);

    // Only handle peeking mode in the pre-gate.
    // Engaged mode and mention filter stay in the sequential queue so that
    // they benefit from the full context built by buildTelegramMessageContext.
    const engagement = engagementStates.get(groupKey);
    if (engagement?.mode === "engaged") {
      return next();
    }

    // If requireMention is false (activation=always), all messages are processed
    // and there is no peeking path to short-circuit.
    const activationOverride = deps.resolveGroupActivation({
      chatId,
      messageThreadId: resolvedThreadId,
    });
    const baseRequireMention = deps.resolveGroupRequireMention(chatId);
    const configRequireMention = (groupConfig as TelegramGroupConfig)?.requireMention;
    const requireMention = activationOverride ?? configRequireMention ?? baseRequireMention;
    if (!requireMention) {
      return next();
    }

    // --- Basic mention detection ---
    // If the message looks like a mention / reply-to-bot, let the sequential
    // queue handle it (it has full mention regex + mention filter logic).
    const botId = ctx.me?.id as number | undefined;
    const botUsername = (ctx.me?.username as string | undefined)?.toLowerCase();
    const replyFromId = msg.reply_to_message?.from?.id;
    if (botId != null && replyFromId === botId) {
      return next();
    }
    if (botUsername && hasBotMention(msg, botUsername)) {
      return next();
    }

    // Check custom mention regexes (cached).
    if (!cachedMentionRegexes) {
      const agentId = resolveDefaultAgentId(deps.cfg);
      cachedMentionRegexes = buildMentionRegexes(deps.cfg, agentId);
    }
    const textToCheck = (msg.text ?? msg.caption ?? "") as string;
    if (cachedMentionRegexes.some((re) => re.test(textToCheck))) {
      return next();
    }

    // --- Build sender label & body ---
    // Match the format used by buildSenderLabel: "Name (@username) id:123"
    const senderId = msg.from?.id ? String(msg.from.id) : String(chatId);
    const senderFirst = msg.from?.first_name ?? "";
    const senderLast = msg.from?.last_name ?? "";
    const senderUsername = msg.from?.username ? `@${msg.from.username}` : undefined;
    const baseName = [senderFirst, senderLast].filter(Boolean).join(" ").trim() || senderUsername;
    const nameWithUsername =
      baseName && senderUsername && baseName !== senderUsername
        ? `${baseName} (${senderUsername})`
        : (baseName ?? undefined);
    const senderName = nameWithUsername ? `${nameWithUsername} id:${senderId}` : `id:${senderId}`;

    const rawBody = textToCheck.trim() || resolvePlaceholder(msg) || "";
    if (!rawBody) {
      return next();
    } // Nothing to evaluate

    // Reply context
    const replyTo = msg.reply_to_message;
    const replyToId = replyTo?.message_id != null ? String(replyTo.message_id) : undefined;
    const replyToBody = (replyTo?.text ?? replyTo?.caption ?? undefined) as string | undefined;
    const replyToSenderFirst = replyTo?.from?.first_name ?? "";
    const replyToSenderLast = replyTo?.from?.last_name ?? "";
    const replyToUsername = replyTo?.from?.username;
    const replyToName =
      [replyToSenderFirst, replyToSenderLast].filter(Boolean).join(" ").trim() ||
      (replyToUsername ? `@${replyToUsername}` : undefined);
    const replyToSender = replyToName ?? undefined;

    const historyEntry: HistoryEntry = {
      sender: senderName,
      body: rawBody,
      timestamp: msg.date ? msg.date * 1000 : undefined,
      messageId: typeof msg.message_id === "number" ? String(msg.message_id) : undefined,
      replyToId,
      replyToBody,
      replyToSender,
    };

    // --- Stale message check ---
    const seqKey = getTelegramSequentialKey(ctx);
    const latestMsgId = deps.latestGroupMessageIds.get(seqKey);
    const isStale =
      typeof msg.message_id === "number" &&
      typeof latestMsgId === "number" &&
      msg.message_id < latestMsgId;

    if (isStale) {
      logVerbose(
        `[contextual-pre-gate] Telegram ${chatId}: skipping stale #${msg.message_id} (latest: #${latestMsgId})`,
      );
      recordPendingHistoryEntryIfEnabled({
        historyMap: deps.groupHistories,
        historyKey: groupKey,
        limit: deps.historyLimit,
        entry: historyEntry,
      });
      return; // Don't call next() — never enters sequential queue
    }

    // --- Download image for decision model (if present) ---
    let imagePaths: string[] | undefined;
    const hasVisualMedia = msg.photo || msg.sticker || msg.animation;
    if (hasVisualMedia) {
      try {
        const media = await resolveMedia(ctx, deps.mediaMaxBytes, deps.token, deps.proxyFetch);
        if (media?.path && media.contentType?.startsWith("image/")) {
          imagePaths = [media.path];
        }
      } catch (err) {
        logVerbose(
          `[contextual-pre-gate] Failed to download media for decision model: ${String(err)}`,
        );
      }
    }

    // --- Run peeking decision model concurrently ---
    const existingHistory = deps.groupHistories.get(groupKey) ?? [];
    const recentMessages = existingHistory.map((h) => ({
      sender: h.sender,
      body: h.body,
      timestamp: h.timestamp,
      messageId: h.messageId,
      replyToId: h.replyToId,
      replyToBody: h.replyToBody,
      replyToSender: h.replyToSender,
    }));

    const decision = await shouldParticipateInGroup({
      cfg: deps.cfg,
      config: contextualConfig,
      recentMessages,
      currentMessage: {
        sender: senderName,
        body: rawBody,
        timestamp: msg.date ? msg.date * 1000 : undefined,
        imagePaths,
        messageId: typeof msg.message_id === "number" ? String(msg.message_id) : undefined,
        replyToId,
        replyToBody,
        replyToSender,
      },
      groupKey,
      botName: (ctx.me?.first_name ?? ctx.me?.username) as string | undefined,
    });

    if (decision.shouldProcess) {
      // Tag the context so buildTelegramMessageContext can skip the redundant call.
      preGateResults.set(ctx, { shouldProcess: true, hint: decision.reason });
      return next();
    }

    // Skip — record history and do not enter the sequential queue.
    recordPendingHistoryEntryIfEnabled({
      historyMap: deps.groupHistories,
      historyKey: groupKey,
      limit: deps.historyLimit,
      entry: historyEntry,
    });
    // Don't call next() — message is fully handled here.
  };
}
