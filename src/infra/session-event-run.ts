import { randomUUID } from "node:crypto";
import { dispatchInboundMessageWithDispatcher } from "../auto-reply/dispatch.js";
import { routeReply } from "../auto-reply/reply/route-reply.js";
import { normalizeChannelId } from "../channels/plugins/index.js";
import { createReplyPrefixOptions } from "../channels/reply-prefix.js";
import { loadSessionEntry, resolveGatewaySessionStoreTarget } from "../gateway/session-utils.js";
import { logWarn } from "../logger.js";
import { getQueueSize } from "../process/command-queue.js";
import { CommandLane } from "../process/lanes.js";
import { resolveAgentIdFromSessionKey } from "../routing/session-key.js";
import { deliveryContextFromSession } from "../utils/delivery-context.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../utils/message-channel.js";
import { isAgentScopedSessionKey } from "./session-event-target.js";
import { hasSystemEvents } from "./system-events.js";

const DEFAULT_COALESCE_MS = 250;
const DEFAULT_RETRY_MS = 1_000;
const DEFAULT_DISPATCH_TIMEOUT_MS = 30_000;

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

function normalizePendingTarget(value?: string): string | undefined {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed || undefined;
}

function getPendingKey(params: { sessionKey: string }) {
  return params.sessionKey.trim();
}

function resolveSessionEventQueueKeys(keys: Array<string | null | undefined>): string[] {
  const visited = new Set<string>();
  const resolved: string[] = [];
  for (const candidate of keys) {
    const key = normalizePendingTarget(candidate);
    if (!key || visited.has(key)) {
      continue;
    }
    visited.add(key);
    resolved.push(key);
  }
  return resolved;
}

function resolveSessionEventQueueKey(keys: string[]): string | undefined {
  for (const key of keys) {
    if (hasSystemEvents(key)) {
      return key;
    }
  }
  return undefined;
}

async function dispatchSessionEventWithTimeout(params: {
  cfg: ReturnType<typeof loadSessionEntry>["cfg"];
  dispatchSessionKey: string;
  source: string;
  agentId: string;
  delivery: ReturnType<typeof deliveryContextFromSession>;
}) {
  const normalizedOriginChannel = params.delivery?.channel
    ? (normalizeChannelId(params.delivery.channel) ?? params.delivery.channel)
    : undefined;
  const normalizedOriginTo = params.delivery?.to?.trim() || undefined;

  const { onModelSelected, ...prefixOptions } = createReplyPrefixOptions({
    cfg: params.cfg,
    agentId: params.agentId,
    channel: normalizedOriginChannel,
    accountId: params.delivery?.accountId,
  });

  let timeoutHandle: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      dispatchInboundMessageWithDispatcher({
        cfg: params.cfg,
        ctx: {
          Body: "",
          RawBody: "",
          CommandBody: "",
          BodyForAgent: "",
          BodyForCommands: "",
          SessionKey: params.dispatchSessionKey,
          Provider: INTERNAL_MESSAGE_CHANNEL,
          Surface: INTERNAL_MESSAGE_CHANNEL,
          OriginatingChannel: normalizedOriginChannel,
          OriginatingTo: normalizedOriginTo,
          AccountId: params.delivery?.accountId,
          MessageThreadId: params.delivery?.threadId,
          MessageSid: `${params.source}:${randomUUID()}`,
          CommandAuthorized: true,
        },
        dispatcherOptions: {
          ...prefixOptions,
          deliver: async (payload) => {
            if (!normalizedOriginChannel || !normalizedOriginTo) {
              return;
            }
            const routed = await routeReply({
              payload,
              channel: normalizedOriginChannel,
              to: normalizedOriginTo,
              sessionKey: params.dispatchSessionKey,
              accountId: params.delivery?.accountId,
              threadId: params.delivery?.threadId,
              cfg: params.cfg,
            });
            if (!routed.ok) {
              logWarn(`session event dispatch delivery failed: ${routed.error ?? "unknown error"}`);
            }
          },
          onError: (err, info) => {
            logWarn(`session event dispatch ${info.kind} failed: ${String(err)}`);
          },
        },
        replyOptions: {
          suppressTyping: true,
          allowEmptyBodyForSystemEvent: true,
          onModelSelected,
        },
      }),
      new Promise<never>((_resolve, reject) => {
        timeoutHandle = setTimeout(
          () =>
            reject(
              new Error(`session event dispatch timed out (${DEFAULT_DISPATCH_TIMEOUT_MS}ms)`),
            ),
          DEFAULT_DISPATCH_TIMEOUT_MS,
        );
        timeoutHandle.unref?.();
      }),
    ]);
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
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
  const key = getPendingKey({ sessionKey });
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
    if (running) {
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
      if (pendingSessionRuns.size > 0) {
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

  const { cfg, canonicalKey, entry, legacyKey, store } = loadSessionEntry(sessionKey);
  if (!isAgentScopedSessionKey(canonicalKey)) {
    return { status: "skipped", reason: "non-agent-session" };
  }
  const { storeKeys } = resolveGatewaySessionStoreTarget({
    cfg,
    key: sessionKey,
    store,
    scanLegacyKeys: true,
  });
  const candidateSessionKeys = resolveSessionEventQueueKeys([
    ...storeKeys,
    canonicalKey,
    sessionKey,
    legacyKey,
  ]);
  const dispatchSessionKey = resolveSessionEventQueueKey(candidateSessionKeys);
  if (!dispatchSessionKey) {
    return { status: "skipped", reason: "no-system-events" };
  }
  if (getQueueSize(CommandLane.Main) > 0) {
    return { status: "skipped", reason: "requests-in-flight" };
  }

  const delivery = deliveryContextFromSession(entry);
  // Follow-up: internal webchat sessions are currently non-routable in route-reply,
  // so event-driven runs may not produce outbound replies on webchat-bound sessions.
  const resolvedAgentId = params.agentId ?? resolveAgentIdFromSessionKey(canonicalKey);
  const source = params.source.trim() || "system-event";
  await dispatchSessionEventWithTimeout({
    cfg,
    dispatchSessionKey,
    source,
    agentId: resolvedAgentId,
    delivery,
  });
  for (const nextSessionKey of candidateSessionKeys) {
    if (nextSessionKey === dispatchSessionKey) {
      continue;
    }
    if (!hasSystemEvents(nextSessionKey)) {
      continue;
    }
    // Mixed alias/canonical keys can hold separate queued system events for the
    // same logical session. Queue a follow-up run so both queues drain.
    queuePendingSessionRun({
      sessionKey: nextSessionKey,
      source,
      agentId: params.agentId,
    });
  }

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
}
