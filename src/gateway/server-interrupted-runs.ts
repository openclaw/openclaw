import path from "node:path";
import { resolveAgentSessionDirs } from "../agents/session-dirs.js";
import { resolveAnnounceTargetFromKey } from "../agents/tools/sessions-send-helpers.js";
import { normalizeChannelId } from "../channels/plugins/index.js";
import { loadConfig } from "../config/config.js";
import { resolveStateDir } from "../config/paths.js";
import { loadSessionStore, type SessionEntry, updateSessionStore } from "../config/sessions.js";
import { parseSessionThreadInfo } from "../config/sessions/delivery-info.js";
import { deliverOutboundPayloads } from "../infra/outbound/deliver.js";
import { buildOutboundSessionContext } from "../infra/outbound/session-context.js";
import { resolveOutboundTarget } from "../infra/outbound/targets.js";
import { enqueueSystemEvent } from "../infra/system-events.js";
import { deliveryContextFromSession, mergeDeliveryContext } from "../utils/delivery-context.js";

type InterruptedSession = {
  storePath: string;
  sessionKey: string;
  entry: SessionEntry;
};

const RUN_SUMMARY_MAX_CHARS = 140;

function formatInterruptedRunSummary(summary: string | undefined): string | undefined {
  const normalized = (summary ?? "").replace(/\s+/g, " ").trim();
  if (!normalized) {
    return undefined;
  }
  if (normalized.length <= RUN_SUMMARY_MAX_CHARS) {
    return normalized;
  }
  return `${normalized.slice(0, RUN_SUMMARY_MAX_CHARS - 1).trimEnd()}…`;
}

function buildInterruptedRunMessage(summary: string | undefined): string {
  const lead =
    "[System] Gateway restarted during an in-flight task. The previous run was interrupted and did not auto-resume.";
  const compactSummary = formatInterruptedRunSummary(summary);
  if (!compactSummary) {
    return `${lead} Send a message to continue.`;
  }
  return `${lead} Last task: "${compactSummary}". Send a message to continue.`;
}

async function markInterruptedRunHandled(params: { storePath: string; sessionKey: string }) {
  const now = Date.now();
  await updateSessionStore(params.storePath, (store) => {
    const current = store[params.sessionKey];
    if (!current) {
      return;
    }
    store[params.sessionKey] = {
      ...current,
      updatedAt: Math.max(current.updatedAt ?? 0, now),
      abortedLastRun: true,
      inFlightRunStartedAt: undefined,
      inFlightRunSummary: undefined,
      inFlightRunSessionId: undefined,
    };
  });
}

async function loadInterruptedSessions(): Promise<InterruptedSession[]> {
  const sessionDirs = await resolveAgentSessionDirs(resolveStateDir(process.env));
  const sessions: InterruptedSession[] = [];
  for (const sessionsDir of sessionDirs) {
    const storePath = path.join(sessionsDir, "sessions.json");
    const store = loadSessionStore(storePath, { skipCache: true });
    for (const [sessionKey, entry] of Object.entries(store)) {
      if (!entry || typeof entry !== "object") {
        continue;
      }
      if (typeof entry.inFlightRunStartedAt !== "number" || entry.inFlightRunStartedAt <= 0) {
        continue;
      }
      sessions.push({ storePath, sessionKey, entry });
    }
  }
  return sessions;
}

async function notifyInterruptedSession(params: {
  cfg: ReturnType<typeof loadConfig>;
  sessionKey: string;
  entry: SessionEntry;
  message: string;
}) {
  const { sessionKey, entry, message } = params;
  const { baseSessionKey, threadId: sessionThreadId } = parseSessionThreadInfo(sessionKey);
  const parsedTarget = resolveAnnounceTargetFromKey(baseSessionKey ?? sessionKey);
  const origin = mergeDeliveryContext(deliveryContextFromSession(entry), parsedTarget ?? undefined);
  const channelRaw = origin?.channel;
  const channel = channelRaw ? normalizeChannelId(channelRaw) : null;
  const to = origin?.to;
  if (!channel || !to) {
    enqueueSystemEvent(message, { sessionKey });
    return;
  }
  const resolved = resolveOutboundTarget({
    channel,
    to,
    cfg: params.cfg,
    accountId: origin?.accountId,
    mode: "implicit",
  });
  if (!resolved.ok) {
    enqueueSystemEvent(message, { sessionKey });
    return;
  }
  const threadId =
    parsedTarget?.threadId ??
    sessionThreadId ??
    (origin?.threadId != null ? String(origin.threadId) : undefined);
  const isSlack = channel === "slack";
  const replyToId = isSlack && threadId != null && threadId !== "" ? String(threadId) : undefined;
  const resolvedThreadId = isSlack ? undefined : threadId;
  const outboundSession = buildOutboundSessionContext({
    cfg: params.cfg,
    sessionKey,
  });
  await deliverOutboundPayloads({
    cfg: params.cfg,
    channel,
    to: resolved.to,
    accountId: origin?.accountId,
    replyToId,
    threadId: resolvedThreadId,
    payloads: [{ text: message }],
    session: outboundSession,
    bestEffort: true,
  });
}

export async function scheduleInterruptedRunsWake() {
  const interrupted = await loadInterruptedSessions();
  if (interrupted.length === 0) {
    return;
  }
  const cfg = loadConfig();
  for (const session of interrupted) {
    const message = buildInterruptedRunMessage(session.entry.inFlightRunSummary);
    await markInterruptedRunHandled({
      storePath: session.storePath,
      sessionKey: session.sessionKey,
    });
    try {
      await notifyInterruptedSession({
        cfg,
        sessionKey: session.sessionKey,
        entry: session.entry,
        message,
      });
    } catch (err) {
      enqueueSystemEvent(`${message}\nDelivery failed: ${String(err)}`, {
        sessionKey: session.sessionKey,
      });
    }
  }
}

export function shouldWakeInterruptedRuns() {
  return !process.env.VITEST && process.env.NODE_ENV !== "test";
}
