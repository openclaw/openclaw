import { asNonNegativeFiniteNumber as readChatSendTimingNumber } from "@openclaw/normalization-core/number-coercion";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { ChatQueueItem } from "../../lib/chat/chat-types.ts";
import { visibleSessionMatches, type SessionScopeHost } from "../../lib/sessions/index.ts";
import { readChatQueueForScope } from "./chat-queue.ts";
import type { ChatSendAck, ChatSendTimingEntry } from "./chat-send-ack.ts";
import {
  controlUiNowMs,
  recordControlUiPerformanceEvent,
  roundedControlUiDurationMs,
  scheduleControlUiAfterPaint,
} from "./performance.ts";
import type { RenderLifecycle } from "./render-lifecycle.ts";

type ChatSendTimingPhase =
  | "pending-visible"
  | "pending-painted"
  | "request-start"
  | "ack"
  | `server-${ChatSendServerTimingPhase}`
  | "queued-busy"
  | "waiting-model"
  | "waiting-reconnect"
  | "failed";

type ChatSendTimingHost = SessionScopeHost & {
  sessionKey: string;
  chatStream: string | null;
  chatQueue: ChatQueueItem[];
  chatSendTimingsByRun?: Map<string, ChatSendTimingEntry>;
  eventLogBuffer?: unknown[];
  renderLifecycle?: RenderLifecycle;
};

const CHAT_SEND_SERVER_TIMING_PHASES = [
  "dispatch-started",
  "model-selected",
  "agent-run-started",
  "first-assistant-event",
  "dispatch-completed",
  "post-dispatch-completed",
] as const;
type ChatSendServerTimingPhase = (typeof CHAT_SEND_SERVER_TIMING_PHASES)[number];
const CHAT_SEND_SLOW_FIRST_ASSISTANT_MS = 1_500;

export function recordChatSendTiming(
  host: ChatSendTimingHost,
  item: Pick<
    ChatQueueItem,
    "sendRunId" | "sessionKey" | "agentId" | "sendAttempts" | "sendState" | "sendSubmittedAtMs"
  >,
  phase: ChatSendTimingPhase,
  startedAtMs = item.sendSubmittedAtMs,
  extra: Record<string, unknown> = {},
) {
  if (startedAtMs == null) {
    return;
  }
  recordControlUiPerformanceEvent(
    host,
    "control-ui.chat.send",
    {
      phase,
      durationMs: roundedControlUiDurationMs(controlUiNowMs() - startedAtMs),
      runId: item.sendRunId,
      sessionKey: item.sessionKey,
      agentId: item.agentId,
      sendAttempts: item.sendAttempts ?? 0,
      sendState: item.sendState,
      ...extra,
    },
    { console: false, maxBufferedEventsForType: 40 },
  );
}

export function recordChatSendServerTiming(host: ChatSendTimingHost, payload: unknown) {
  if (!payload || typeof payload !== "object") {
    return;
  }
  const record = payload as Record<string, unknown>;
  const phase = CHAT_SEND_SERVER_TIMING_PHASES.find((candidate) => candidate === record.phase);
  const runId = normalizeOptionalString(record.runId);
  if (!phase || !runId) {
    return;
  }
  const entry = host.chatSendTimingsByRun?.get(runId);
  const nowMs = controlUiNowMs();
  const serverAckToPhaseMs = readChatSendTimingNumber(record.ackToPhaseMs);
  const serverReceivedToPhaseMs = readChatSendTimingNumber(record.receivedToPhaseMs);
  const serverDispatchStartedToPhaseMs = readChatSendTimingNumber(record.dispatchStartedToPhaseMs);
  const serverPostDispatchMs = readChatSendTimingNumber(record.postDispatchMs);
  const durationMs =
    entry?.submittedAtMs !== undefined
      ? roundedControlUiDurationMs(nowMs - entry.submittedAtMs)
      : serverAckToPhaseMs;
  if (durationMs === undefined) {
    return;
  }
  const slow = phase === "first-assistant-event" && durationMs >= CHAT_SEND_SLOW_FIRST_ASSISTANT_MS;
  const identity: Record<string, string> = {};
  for (const key of ["provider", "model", "agentRunId"] as const) {
    const value = normalizeOptionalString(record[key]);
    if (value) {
      identity[key] = value;
    }
  }
  recordControlUiPerformanceEvent(
    host,
    "control-ui.chat.send",
    {
      phase: `server-${phase}`,
      durationMs,
      runId,
      sessionKey: entry?.sessionKey ?? normalizeOptionalString(record.sessionKey),
      agentId: entry?.agentId ?? normalizeOptionalString(record.agentId),
      sendAttempts: entry?.sendAttempts ?? 0,
      sendState: entry?.sendState,
      ackStatus: entry?.ackStatus,
      serverPhase: phase,
      ...(serverAckToPhaseMs !== undefined ? { serverAckToPhaseMs } : {}),
      ...(serverReceivedToPhaseMs !== undefined ? { serverReceivedToPhaseMs } : {}),
      ...(serverDispatchStartedToPhaseMs !== undefined ? { serverDispatchStartedToPhaseMs } : {}),
      ...(serverPostDispatchMs !== undefined ? { serverPostDispatchMs } : {}),
      ...identity,
      ...(slow ? { slow: true } : {}),
    },
    { console: slow, warn: slow, maxBufferedEventsForType: 40 },
  );
}

export function registerChatSendTiming(
  host: ChatSendTimingHost,
  item: Pick<
    ChatQueueItem,
    "sendRunId" | "sessionKey" | "agentId" | "sendAttempts" | "sendState" | "sendSubmittedAtMs"
  >,
  runId: string,
  requestStartedAtMs: number,
) {
  (host.chatSendTimingsByRun ??= new Map()).set(runId, {
    runId,
    sessionKey: item.sessionKey,
    agentId: item.agentId,
    sendAttempts: item.sendAttempts ?? 0,
    sendState: item.sendState,
    submittedAtMs: item.sendSubmittedAtMs ?? requestStartedAtMs,
    requestStartedAtMs,
  });
}

export function updateChatSendAckTiming(
  host: ChatSendTimingHost,
  requestedRunId: string,
  ack: ChatSendAck,
  item: Pick<
    ChatQueueItem,
    "sessionKey" | "agentId" | "sendAttempts" | "sendState" | "sendSubmittedAtMs"
  >,
  requestStartedAtMs: number,
) {
  const entries = (host.chatSendTimingsByRun ??= new Map());
  const existing = entries.get(requestedRunId);
  const submittedAtMs = existing?.submittedAtMs ?? item.sendSubmittedAtMs ?? requestStartedAtMs;
  const next: ChatSendTimingEntry = {
    ...(existing ?? {
      sendAttempts: item.sendAttempts ?? 0,
      sendState: item.sendState,
      submittedAtMs,
      requestStartedAtMs,
    }),
    runId: ack.runId,
    sessionKey: existing?.sessionKey ?? item.sessionKey,
    agentId: existing?.agentId ?? item.agentId,
    ackAtMs: controlUiNowMs(),
    ackStatus: ack.status,
  };
  if (ack.runId !== requestedRunId) {
    entries.delete(requestedRunId);
  }
  entries.set(ack.runId, next);
}

export function chatSendAckServerTimingEventFields(ack: ChatSendAck): Record<string, number> {
  const timing = ack.serverTiming;
  return {
    ...(typeof timing?.receivedToAckMs === "number"
      ? { serverReceivedToAckMs: timing.receivedToAckMs }
      : {}),
    ...(typeof timing?.loadSessionMs === "number"
      ? { serverLoadSessionMs: timing.loadSessionMs }
      : {}),
    ...(typeof timing?.prepareAttachmentsMs === "number"
      ? { serverPrepareAttachmentsMs: timing.prepareAttachmentsMs }
      : {}),
  };
}

function shouldRecordPendingSendPaint(item: ChatQueueItem): boolean {
  return (
    typeof item.sendSubmittedAtMs === "number" &&
    (item.sendState === "waiting-model" ||
      item.sendState === "waiting-idle" ||
      item.sendState === "submitting" ||
      item.sendState === "sending" ||
      item.sendState === "waiting-reconnect")
  );
}

export function schedulePendingSendPaintTiming(
  host: ChatSendTimingHost,
  item: ChatQueueItem,
  startedAtMs = item.sendSubmittedAtMs,
) {
  const sessionKey = item.sessionKey ?? host.sessionKey;
  const sendRunId = item.sendRunId;
  if (!sendRunId || startedAtMs == null) {
    return;
  }
  scheduleControlUiAfterPaint(host, () => {
    if (!visibleSessionMatches(host, sessionKey, item.agentId)) {
      return;
    }
    const queued = readChatQueueForScope(host, sessionKey, item.agentId).find(
      (entry) => entry.id === item.id && entry.sendRunId === sendRunId,
    );
    if (!queued || !shouldRecordPendingSendPaint(queued)) {
      return;
    }
    recordChatSendTiming(host, queued, "pending-painted", startedAtMs);
  });
}
