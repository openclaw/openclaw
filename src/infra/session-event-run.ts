import { randomUUID } from "node:crypto";
import { dispatchInboundMessageWithDispatcher } from "../auto-reply/dispatch.js";
import { normalizeChannelId } from "../channels/plugins/index.js";
import { createReplyPrefixOptions } from "../channels/reply-prefix.js";
import { loadSessionEntry } from "../gateway/session-utils.js";
import { logWarn } from "../logger.js";
import { getQueueSize } from "../process/command-queue.js";
import { CommandLane } from "../process/lanes.js";
import { resolveAgentIdFromSessionKey } from "../routing/session-key.js";
import { deliveryContextFromSession } from "../utils/delivery-context.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../utils/message-channel.js";
import { hasSystemEvents } from "./system-events.js";

const DEFAULT_COALESCE_MS = 250;
const DEFAULT_RETRY_MS = 1_000;

type SessionEventRunResult =
  | { status: "ran" }
  | {
      status: "skipped";
      reason: "invalid-session" | "non-agent-session" | "no-system-events" | "requests-in-flight";
    };

type PendingSessionEventRun = {
  sessionKey: string;
  source: string;
  agentId?: string;
  requestedAt: number;
};

type WakeTimerKind = "normal" | "retry";

const pendingSessionRuns = new Map<string, PendingSessionEventRun>();
let runTimer: NodeJS.Timeout | null = null;
let runTimerDueAt: number | null = null;
let runTimerKind: WakeTimerKind | null = null;
let running = false;
let scheduled = false;

function shouldUseSessionScopedEventRun(sessionKey?: string): boolean {
  return typeof sessionKey === "string" && sessionKey.trim().toLowerCase().startsWith("agent:");
}

function normalizePendingTarget(value?: string): string | undefined {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed || undefined;
}

function getPendingKey(params: { sessionKey: string; agentId?: string }) {
  const sessionKey = params.sessionKey.trim();
  const agentId = normalizePendingTarget(params.agentId);
  return `${agentId ?? ""}::${sessionKey}`;
}

function queuePendingSessionRun(params: {
  sessionKey: string;
  source: string;
  agentId?: string;
  requestedAt?: number;
}) {
  const sessionKey = params.sessionKey.trim();
  if (!sessionKey) {
    return;
  }
  const source = params.source.trim() || "system-event";
  const requestedAt = params.requestedAt ?? Date.now();
  const key = getPendingKey({ sessionKey, agentId: params.agentId });
  const next: PendingSessionEventRun = {
    sessionKey,
    source,
    agentId: normalizePendingTarget(params.agentId),
    requestedAt,
  };
  const previous = pendingSessionRuns.get(key);
  if (!previous || next.requestedAt >= previous.requestedAt) {
    pendingSessionRuns.set(key, next);
  }
}

function schedulePendingSessionRuns(delayMs: number, kind: WakeTimerKind = "normal") {
  const delay = Number.isFinite(delayMs) ? Math.max(0, delayMs) : DEFAULT_COALESCE_MS;
  const dueAt = Date.now() + delay;
  if (runTimer) {
    // Keep retry cooldown as a minimum so normal coalescing cannot collapse backoff.
    if (runTimerKind === "retry") {
      return;
    }
    if (typeof runTimerDueAt === "number" && runTimerDueAt <= dueAt) {
      return;
    }
    clearTimeout(runTimer);
    runTimer = null;
    runTimerDueAt = null;
    runTimerKind = null;
  }
  runTimerDueAt = dueAt;
  runTimerKind = kind;
  runTimer = setTimeout(async () => {
    runTimer = null;
    runTimerDueAt = null;
    runTimerKind = null;
    scheduled = false;
    if (running) {
      scheduled = true;
      schedulePendingSessionRuns(delay, kind);
      return;
    }

    const batch = Array.from(pendingSessionRuns.values());
    pendingSessionRuns.clear();
    running = true;
    try {
      for (const pending of batch) {
        let result: SessionEventRunResult;
        try {
          result = await runSessionEventOnce(pending);
        } catch (err) {
          // Isolate failures per session target so one bad run does not drop
          // unrelated queued wakes from the same drain batch.
          logWarn(
            `session event run failed: source=${pending.source} session=${pending.sessionKey} error=${String(err)}`,
          );
          queuePendingSessionRun({
            sessionKey: pending.sessionKey,
            source: pending.source,
            agentId: pending.agentId,
          });
          schedulePendingSessionRuns(DEFAULT_RETRY_MS, "retry");
          continue;
        }
        if (result.status === "skipped" && result.reason === "requests-in-flight") {
          queuePendingSessionRun({
            sessionKey: pending.sessionKey,
            source: pending.source,
            agentId: pending.agentId,
          });
          schedulePendingSessionRuns(DEFAULT_RETRY_MS, "retry");
        }
      }
    } catch (err) {
      logWarn(`session event run failed: ${String(err)}`);
    } finally {
      running = false;
      if (pendingSessionRuns.size > 0 || scheduled) {
        schedulePendingSessionRuns(DEFAULT_COALESCE_MS, "normal");
      }
    }
  }, delay);
  runTimer.unref?.();
}

async function runSessionEventOnce(params: {
  sessionKey: string;
  source: string;
  agentId?: string;
}): Promise<SessionEventRunResult> {
  const sessionKey = params.sessionKey.trim();
  if (!sessionKey) {
    return { status: "skipped", reason: "invalid-session" };
  }

  const { cfg, canonicalKey, entry } = loadSessionEntry(sessionKey);
  if (!shouldUseSessionScopedEventRun(canonicalKey)) {
    return { status: "skipped", reason: "non-agent-session" };
  }
  if (!hasSystemEvents(canonicalKey)) {
    return { status: "skipped", reason: "no-system-events" };
  }
  if (getQueueSize(CommandLane.Main) > 0) {
    return { status: "skipped", reason: "requests-in-flight" };
  }

  const delivery = deliveryContextFromSession(entry);
  // Follow-up: internal webchat sessions are currently non-routable in route-reply,
  // so event-driven runs may not produce outbound replies on webchat-bound sessions.
  const originatingChannel = delivery?.channel
    ? (normalizeChannelId(delivery.channel) ?? delivery.channel)
    : undefined;
  const originatingTo = delivery?.to?.trim() || undefined;
  const resolvedAgentId = params.agentId ?? resolveAgentIdFromSessionKey(canonicalKey);
  const source = params.source.trim() || "system-event";
  const { onModelSelected, ...prefixOptions } = createReplyPrefixOptions({
    cfg,
    agentId: resolvedAgentId,
    channel: originatingChannel,
    accountId: delivery?.accountId,
  });

  await dispatchInboundMessageWithDispatcher({
    cfg,
    ctx: {
      Body: "",
      RawBody: "",
      CommandBody: "",
      BodyForAgent: "",
      BodyForCommands: "",
      SessionKey: canonicalKey,
      Provider: INTERNAL_MESSAGE_CHANNEL,
      Surface: INTERNAL_MESSAGE_CHANNEL,
      OriginatingChannel: originatingChannel,
      OriginatingTo: originatingTo,
      AccountId: delivery?.accountId,
      MessageThreadId: delivery?.threadId,
      MessageSid: `${source}:${randomUUID()}`,
      CommandAuthorized: true,
    },
    dispatcherOptions: {
      ...prefixOptions,
      deliver: async () => {},
      onError: (err, info) => {
        logWarn(`session event dispatch ${info.kind} failed: ${String(err)}`);
      },
    },
    replyOptions: {
      suppressTyping: true,
      allowEmptyBodyForSystemEvent: true,
      onModelSelected,
    },
  });

  return { status: "ran" };
}

export async function triggerSessionEventRun(params: {
  sessionKey: string;
  source: string;
  agentId?: string;
}): Promise<boolean> {
  const result = await runSessionEventOnce(params);
  return result.status === "ran";
}

export function requestSessionEventRun(params: {
  sessionKey: string;
  source: string;
  agentId?: string;
}) {
  queuePendingSessionRun(params);
  schedulePendingSessionRuns(DEFAULT_COALESCE_MS, "normal");
}

export function resetSessionEventRunStateForTests() {
  if (runTimer) {
    clearTimeout(runTimer);
  }
  runTimer = null;
  runTimerDueAt = null;
  runTimerKind = null;
  pendingSessionRuns.clear();
  running = false;
  scheduled = false;
}
