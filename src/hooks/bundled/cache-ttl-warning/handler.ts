/**
 * Cache TTL Warning Hook Handler
 *
 * Tracks the last message time per conversation and sends a warning before
 * the Anthropic prompt cache TTL (5 minutes) expires. Fires on both
 * message:sent and message:received events so any activity resets the clock.
 *
 * Uses in-process setTimeout timers — no LLM, no sub-agents, essentially free.
 * Timer state is per-process; a gateway restart clears all timers (acceptable).
 */

import { routeReply } from "../../../auto-reply/reply/route-reply.js";
import { loadConfig } from "../../../config/config.js";
import { createSubsystemLogger } from "../../../logging/subsystem.js";
import {
  deleteMessageTelegram,
  resolveTelegramToken,
  sendMessageTelegram,
} from "../../../plugin-sdk/telegram.js";
import { resolveHookConfig } from "../../config.js";
import type { HookHandler } from "../../hooks.js";

const log = createSubsystemLogger("hooks/cache-ttl-warning");

const DEFAULT_WARNING_SECONDS = 240; // 4 minutes
const DEFAULT_EXPIRED_SECONDS = 300; // 5 minutes

interface ConversationTimer {
  warningTimer: ReturnType<typeof setTimeout> | undefined;
  expiredTimer: ReturnType<typeof setTimeout> | undefined;
  /** The original "to" target set when the timer was first created (e.g. chat ID). */
  originalTo: string;
  /** Message ID of the most recent TTL notice (warning or expired), so we can delete it on reset. */
  lastNoticeMessageId?: string;
  /** Channel + to needed to delete the notice when the timer is reset by new activity. */
  lastNoticeChannel?: string;
  lastNoticeTo?: string;
}

// Singleton timer state — survives across hook invocations within one process
const SINGLETON_KEY = "__cache_ttl_warning_timers__";
type TimerStore = Map<string, ConversationTimer>;

// Guard flag: set to true while the hook is sending a notice to prevent
// the resulting message:sent event from re-triggering the timer reset.
const SENDING_KEY = "__cache_ttl_warning_sending__";
function getSendingSet(): Set<string> {
  const g = globalThis as Record<string, unknown>;
  if (!g[SENDING_KEY]) {
    g[SENDING_KEY] = new Set<string>();
  }
  return g[SENDING_KEY] as Set<string>;
}

function getTimerStore(): TimerStore {
  const g = globalThis as Record<string, unknown>;
  if (!g[SINGLETON_KEY]) {
    g[SINGLETON_KEY] = new Map<string, ConversationTimer>();
  }
  return g[SINGLETON_KEY] as TimerStore;
}

function clearConversationTimers(store: TimerStore, key: string): void {
  const existing = store.get(key);
  if (existing) {
    if (existing.warningTimer) {
      clearTimeout(existing.warningTimer);
    }
    if (existing.expiredTimer) {
      clearTimeout(existing.expiredTimer);
    }
    // Delete any previously sent TTL notice so only the most recent one is visible
    if (existing.lastNoticeMessageId && existing.lastNoticeChannel && existing.lastNoticeTo) {
      void deleteWarningMessage({
        channelId: existing.lastNoticeChannel,
        to: existing.lastNoticeTo,
        messageId: existing.lastNoticeMessageId,
      });
    }
    store.delete(key);
  }
}

/**
 * Normalize a channelId to just the provider name (e.g. "telegram:7898601152" → "telegram").
 * Some event contexts pass the full "provider:chatId" form instead of just "provider".
 * routeReply expects the bare provider name and returns ok=false for unknown channels.
 */
function normalizeChannelForSend(channelId: string): string {
  // Strip ":anything" suffix — keep only the provider prefix
  return channelId.replace(/:.*$/, "");
}

async function sendCacheNotice(params: {
  channelId: string;
  to: string;
  conversationKey: string;
  kind: "warning" | "expired";
}): Promise<{ messageId?: string }> {
  const text =
    params.kind === "warning"
      ? "⏱️ Prompt cache expires in ~1 min — send any message to reset it."
      : "🕐 Prompt cache expired. Next message will reload the full context.";

  const sendingSet = getSendingSet();
  // Set guard before sending so the resulting message:sent event is ignored
  sendingSet.add(params.conversationKey);
  try {
    const cfg = loadConfig();
    const normalizedChannel = normalizeChannelForSend(params.channelId);

    // Use sendMessageTelegram directly to bypass routeReply which can fail with
    // "Unknown channel: telegram" when the plugin registry is corrupted (#48790).
    if (normalizedChannel === "telegram") {
      const { token } = resolveTelegramToken(cfg, {});
      if (!token) {
        log.warn("cache-ttl-warning: no Telegram bot token — cannot send cache notice");
        return {};
      }
      const result = await sendMessageTelegram(params.to, text, { cfg, token });
      log.info(
        `cache-ttl-warning: sent ${params.kind} notice to ${params.to} (messageId=${result.messageId})`,
      );
      return { messageId: result.messageId };
    }

    // Non-Telegram: fall back to routeReply
    const result = await routeReply({
      payload: { text },
      channel: normalizedChannel as Parameters<typeof routeReply>[0]["channel"],
      to: params.to,
      cfg,
    });
    if (!result.ok) {
      log.warn(
        `cache-ttl-warning: routeReply returned ok=false for ${params.kind} notice to ${params.to}: ${result.error ?? "unknown error"}`,
      );
      return {};
    }
    log.info(`cache-ttl-warning: sent ${params.kind} notice to ${params.to}`);
    return { messageId: result.messageId };
  } catch (err) {
    log.warn(`cache-ttl-warning: failed to send ${params.kind} notice: ${String(err)}`);
    return {};
  } finally {
    sendingSet.delete(params.conversationKey);
  }
}

async function deleteWarningMessage(params: {
  channelId: string;
  to: string;
  messageId: string;
}): Promise<void> {
  // Only Telegram supports delete-by-message-id in this hook
  if (!params.channelId.includes("telegram")) {
    return;
  }
  try {
    const cfg = loadConfig();
    const { token } = resolveTelegramToken(cfg, {});
    if (!token) {
      log.warn("cache-ttl-warning: no Telegram bot token — cannot delete warning message");
      return;
    }
    await deleteMessageTelegram(params.to, params.messageId, { cfg, token });
    log.info(`cache-ttl-warning: deleted warning message ${params.messageId} from ${params.to}`);
  } catch (err) {
    // Non-fatal — message may have already been deleted or expired in Telegram
    log.warn(`cache-ttl-warning: failed to delete warning message: ${String(err)}`);
  }
}

function makeConversationKey(channelId: string, conversationId: string): string {
  return `${channelId}:${conversationId}`;
}

function shouldWatch(params: {
  channelId: string;
  conversationId: string;
  isGroup: boolean;
  watchConversations: string[];
}): boolean {
  // Never watch group chats
  if (params.isGroup) {
    return false;
  }

  const { watchConversations, channelId, conversationId } = params;

  // Empty list = watch all direct conversations
  if (!watchConversations || watchConversations.length === 0) {
    return true;
  }

  // Match against multiple key formats — conversationId shape varies:
  // "telegram:7898601152" (provider-prefixed), "7898601152" (bare), etc.
  const fullKey = makeConversationKey(channelId, conversationId);
  const shortKey = makeConversationKey(channelId, conversationId.replace(/^[^:]+:/, ""));
  const bareId = conversationId.replace(/^.*:/, "");
  return (
    watchConversations.includes(fullKey) ||
    watchConversations.includes(shortKey) ||
    watchConversations.includes(bareId) ||
    watchConversations.includes(conversationId)
  );
}

const handler: HookHandler = async (event) => {
  log.info(`cache-ttl-warning: handler invoked type=${event.type} action=${event.action}`);
  const isSent = event.type === "message" && event.action === "sent";
  const isReceived = event.type === "message" && event.action === "received";
  const isLlmRequest = event.type === "agent" && event.action === "llm-request";
  const isSessionReset =
    event.type === "command" && (event.action === "new" || event.action === "reset");

  // On /new or /reset, cancel all active timers — the cache is being discarded
  // and any pending warnings are now stale (and confusing).
  if (isSessionReset) {
    const timerStore = getTimerStore();
    for (const key of timerStore.keys()) {
      clearConversationTimers(timerStore, key);
    }
    log.info(
      `cache-ttl-warning: session reset (command:${event.action}) — cleared all active timers`,
    );
    return;
  }

  if (!isSent && !isReceived && !isLlmRequest) {
    log.info(`cache-ttl-warning: not a message sent/received or llm-request event — skipping`);
    return;
  }

  const cfg = loadConfig();
  const hookCfg = resolveHookConfig(cfg, "cache-ttl-warning");

  if (hookCfg?.enabled === false) {
    return;
  }

  const warningSeconds =
    typeof hookCfg?.["warningSeconds"] === "number"
      ? hookCfg["warningSeconds"]
      : DEFAULT_WARNING_SECONDS;
  const expiredSeconds =
    typeof hookCfg?.["expiredSeconds"] === "number"
      ? hookCfg["expiredSeconds"]
      : DEFAULT_EXPIRED_SECONDS;
  const watchConversations = Array.isArray(hookCfg?.["watchConversations"])
    ? (hookCfg["watchConversations"] as string[])
    : [];

  const warningMs = warningSeconds * 1000;
  const expiredMs = expiredSeconds * 1000;

  // Extract conversation identifiers from the event context
  let channelId: string | undefined;
  let to: string | undefined;
  let conversationId: string | undefined;
  let isGroup = false;

  if (isSent) {
    const ctx = event.context as {
      channelId?: string;
      to?: string;
      conversationId?: string;
      isGroup?: boolean;
    };
    channelId = ctx.channelId;
    to = ctx.to;
    conversationId = ctx.conversationId ?? ctx.to;
    isGroup = ctx.isGroup ?? false;
  } else if (isReceived) {
    const ctx = event.context as {
      channelId?: string;
      from?: string;
      conversationId?: string;
      isGroup?: boolean;
    };
    channelId = ctx.channelId;
    to = ctx.from;
    conversationId = ctx.conversationId ?? ctx.from;
    isGroup = ctx.isGroup ?? false;
  } else if (isLlmRequest) {
    const ctx = event.context as {
      channelId?: string;
      conversationId?: string;
    };
    channelId = ctx.channelId;
    conversationId = ctx.conversationId;
    // LLM requests only reset existing timers — they don't have a "to" for
    // sending notices. We still need channelId + conversationId to look up the
    // correct timer entry.
  }

  if (!channelId || !conversationId) {
    log.info(
      `cache-ttl-warning: missing fields — channelId=${channelId} conversationId=${conversationId} to=${to} isSent=${isSent} isReceived=${isReceived} isLlmRequest=${isLlmRequest}`,
    );
    return;
  }

  // For LLM requests we only need to reset existing timers, not start new ones
  // (we don't have a "to" address for sending notices).
  if (isLlmRequest && !to) {
    const timerStore = getTimerStore();
    const bareConversationId = conversationId.replace(/^.*:/, "");
    const key = makeConversationKey(channelId, bareConversationId);
    const existing = timerStore.get(key);
    if (!existing) {
      log.info(`cache-ttl-warning: llm-request for ${key} but no active timer — skipping`);
      return;
    }
    // Use the original "to" target stored when the timer was first created.
    // Falls back to lastNoticeTo (set after a notice is sent), then bare conversationId.
    to = existing.originalTo ?? existing.lastNoticeTo ?? bareConversationId;
    log.info(`cache-ttl-warning: llm-request reset for ${key} (to=${to})`);
  }

  if (!to) {
    log.info(
      `cache-ttl-warning: missing 'to' field — channelId=${channelId} conversationId=${conversationId}`,
    );
    return;
  }

  const bareConversationIdForLog = conversationId.replace(/^.*:/, "");
  log.info(
    `cache-ttl-warning: checking shouldWatch key=${channelId}:${bareConversationIdForLog} isGroup=${isGroup} watchConversations=${JSON.stringify(watchConversations)}`,
  );
  if (
    !shouldWatch({
      channelId,
      conversationId,
      isGroup,
      watchConversations,
    })
  ) {
    log.info(`cache-ttl-warning: not in watchConversations — skipping`);
    return;
  }

  const timerStore = getTimerStore();
  // Normalize conversationId to bare form (strip any provider/type prefix) so
  // all key variants (e.g. "telegram:7898601152", "slash:7898601152", "7898601152")
  // resolve to the same timer store entry and don't spawn independent timers.
  const bareConversationId = conversationId.replace(/^.*:/, "");
  const key = makeConversationKey(channelId, bareConversationId);

  // If the hook is currently sending a notice, the resulting message:sent event
  // must not reset the timer — that would create a self-triggering loop.
  const sendingSet = getSendingSet();
  if (sendingSet.has(key)) {
    log.info(`cache-ttl-warning: ignoring message:sent triggered by own notice for ${key}`);
    return;
  }

  // Cancel any existing timers for this conversation
  clearConversationTimers(timerStore, key);

  // Capture values for closure
  const capturedChannelId = channelId;
  const capturedTo = to;
  // Strip provider prefix from originalTo for consistency (e.g. "telegram:7898601152" → "7898601152")
  const bareOriginalTo = to.replace(/^[^:]+:/, "");

  const entry: ConversationTimer = {
    warningTimer: undefined,
    expiredTimer: undefined,
    originalTo: bareOriginalTo,
  };

  // Set warning timer
  entry.warningTimer = setTimeout(() => {
    void sendCacheNotice({
      channelId: capturedChannelId,
      to: capturedTo,
      conversationKey: key,
      kind: "warning",
    }).then(({ messageId }) => {
      // Store the notice message ID so it can be deleted on reset or when expired fires
      const currentEntry = timerStore.get(key);
      if (currentEntry && messageId) {
        currentEntry.lastNoticeMessageId = messageId;
        currentEntry.lastNoticeChannel = capturedChannelId;
        currentEntry.lastNoticeTo = capturedTo;
      }
    });
  }, warningMs);

  // Set expired timer (if configured and after warning)
  if (expiredMs > 0 && expiredMs > warningMs) {
    entry.expiredTimer = setTimeout(() => {
      const currentEntry = timerStore.get(key);
      const lastNoticeMessageId = currentEntry?.lastNoticeMessageId;

      // Delete the previous notice (warning) before sending the expired one
      const deletePromise = lastNoticeMessageId
        ? deleteWarningMessage({
            channelId: capturedChannelId,
            to: capturedTo,
            messageId: lastNoticeMessageId,
          })
        : Promise.resolve();

      void deletePromise.then(() => {
        void sendCacheNotice({
          channelId: capturedChannelId,
          to: capturedTo,
          conversationKey: key,
          kind: "expired",
        }).then(({ messageId }) => {
          // Track the expired notice so it can be deleted if activity resumes
          const currentEntry = timerStore.get(key);
          if (currentEntry && messageId) {
            currentEntry.lastNoticeMessageId = messageId;
            currentEntry.lastNoticeChannel = capturedChannelId;
            currentEntry.lastNoticeTo = capturedTo;
          }
        });
      });
    }, expiredMs);
  }

  timerStore.set(key, entry);
  log.info(
    `cache-ttl-warning: timer reset for ${key} (warning in ${warningSeconds}s, expired in ${expiredSeconds}s)`,
  );
};

export default handler;
