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
import { resolveHookConfig } from "../../config.js";
import type { HookHandler } from "../../hooks.js";

const log = createSubsystemLogger("hooks/cache-ttl-warning");

const DEFAULT_WARNING_SECONDS = 240; // 4 minutes
const DEFAULT_EXPIRED_SECONDS = 300; // 5 minutes

interface ConversationTimer {
  warningTimer: ReturnType<typeof setTimeout> | undefined;
  expiredTimer: ReturnType<typeof setTimeout> | undefined;
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
    store.delete(key);
  }
}

async function sendCacheNotice(params: {
  channelId: string;
  to: string;
  conversationKey: string;
  kind: "warning" | "expired";
}): Promise<void> {
  const text =
    params.kind === "warning"
      ? "⏱️ Prompt cache expires in ~1 min — send any message to reset it."
      : "🕐 Prompt cache expired. Next message will reload the full context.";

  const sendingSet = getSendingSet();
  // Set guard before sending so the resulting message:sent event is ignored
  sendingSet.add(params.conversationKey);
  try {
    const cfg = loadConfig();
    await routeReply({
      payload: { text },
      channel: params.channelId as Parameters<typeof routeReply>[0]["channel"],
      to: params.to,
      cfg,
    });
    log.info(`cache-ttl-warning: sent ${params.kind} notice to ${params.to}`);
  } catch (err) {
    log.warn(`cache-ttl-warning: failed to send ${params.kind} notice: ${String(err)}`);
  } finally {
    sendingSet.delete(params.conversationKey);
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

  if (!isSent && !isReceived) {
    log.info(`cache-ttl-warning: not a message sent/received event — skipping`);
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
  }

  if (!channelId || !conversationId || !to) {
    log.info(
      `cache-ttl-warning: missing fields — channelId=${channelId} conversationId=${conversationId} to=${to} isSent=${isSent} isReceived=${isReceived}`,
    );
    return;
  }

  log.info(
    `cache-ttl-warning: checking shouldWatch key=${channelId}:${conversationId} isGroup=${isGroup} watchConversations=${JSON.stringify(watchConversations)}`,
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
  const key = makeConversationKey(channelId, conversationId);

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

  const entry: ConversationTimer = {
    warningTimer: undefined,
    expiredTimer: undefined,
  };

  // Set warning timer
  entry.warningTimer = setTimeout(() => {
    void sendCacheNotice({
      channelId: capturedChannelId,
      to: capturedTo,
      conversationKey: key,
      kind: "warning",
    });
  }, warningMs);

  // Set expired timer (if configured and after warning)
  if (expiredMs > 0 && expiredMs > warningMs) {
    entry.expiredTimer = setTimeout(() => {
      void sendCacheNotice({
        channelId: capturedChannelId,
        to: capturedTo,
        conversationKey: key,
        kind: "expired",
      });
      // Clean up after firing
      timerStore.delete(key);
    }, expiredMs);
  }

  timerStore.set(key, entry);
  log.info(
    `cache-ttl-warning: timer reset for ${key} (warning in ${warningSeconds}s, expired in ${expiredSeconds}s)`,
  );
};

export default handler;
