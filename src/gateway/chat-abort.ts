import { isAbortRequestText } from "../auto-reply/reply/abort-primitives.js";
import {
  emitSessionRunCancel,
  setSessionRunAbortRequester,
} from "../sessions/session-run-cancel.js";

export type ChatAbortControllerEntry = {
  controller: AbortController;
  sessionId: string;
  sessionKey: string;
  startedAtMs: number;
  expiresAtMs: number;
  ownerConnId?: string;
  ownerDeviceId?: string;
};

export function isChatStopCommandText(text: string): boolean {
  return isAbortRequestText(text);
}

export function resolveChatRunExpiresAtMs(params: {
  now: number;
  timeoutMs: number;
  graceMs?: number;
  minMs?: number;
  maxMs?: number;
}): number {
  const { now, timeoutMs, graceMs = 60_000, minMs = 2 * 60_000, maxMs = 24 * 60 * 60_000 } = params;
  const boundedTimeoutMs = Math.max(0, timeoutMs);
  const target = now + boundedTimeoutMs + graceMs;
  const min = now + minMs;
  const max = now + maxMs;
  return Math.min(max, Math.max(min, target));
}

export type ChatAbortOps = {
  chatAbortControllers: Map<string, ChatAbortControllerEntry>;
  chatRunBuffers: Map<string, string>;
  chatDeltaSentAt: Map<string, number>;
  chatDeltaLastBroadcastLen: Map<string, number>;
  chatAbortedRuns: Map<string, number>;
  removeChatRun: (
    sessionId: string,
    clientRunId: string,
    sessionKey?: string,
  ) => { sessionKey: string; clientRunId: string } | undefined;
  agentRunSeq: Map<string, number>;
  broadcast: (event: string, payload: unknown, opts?: { dropIfSlow?: boolean }) => void;
  nodeSendToSession: (sessionKey: string, event: string, payload: unknown) => void;
};

function broadcastChatAborted(
  ops: ChatAbortOps,
  params: {
    runId: string;
    sessionKey: string;
    stopReason?: string;
    partialText?: string;
  },
) {
  const { runId, sessionKey, stopReason, partialText } = params;
  const payload = {
    runId,
    sessionKey,
    seq: (ops.agentRunSeq.get(runId) ?? 0) + 1,
    state: "aborted" as const,
    stopReason,
    message: partialText
      ? {
          role: "assistant",
          content: [{ type: "text", text: partialText }],
          timestamp: Date.now(),
        }
      : undefined,
  };
  ops.broadcast("chat", payload);
  ops.nodeSendToSession(sessionKey, "chat", payload);
}

export function abortChatRunById(
  ops: ChatAbortOps,
  params: {
    runId: string;
    sessionKey: string;
    stopReason?: string;
  },
): { aborted: boolean } {
  const { runId, sessionKey, stopReason } = params;
  const active = ops.chatAbortControllers.get(runId);
  if (!active) {
    return { aborted: false };
  }
  if (active.sessionKey !== sessionKey) {
    return { aborted: false };
  }

  const bufferedText = ops.chatRunBuffers.get(runId);
  const partialText = bufferedText && bufferedText.trim() ? bufferedText : undefined;
  ops.chatAbortedRuns.set(runId, Date.now());
  active.controller.abort();
  ops.chatAbortControllers.delete(runId);
  ops.chatRunBuffers.delete(runId);
  ops.chatDeltaSentAt.delete(runId);
  ops.chatDeltaLastBroadcastLen.delete(runId);
  const removed = ops.removeChatRun(runId, runId, sessionKey);
  // Fan out cancel to delegated-task handlers before broadcasting the UI event
  // so plugin-owned tasks tied to this run observe the stop deterministically.
  emitSessionRunCancel(
    { kind: "session_run", sessionKey, runId },
    stopReason ? { source: "chat-abort", message: stopReason } : { source: "chat-abort" },
  );
  broadcastChatAborted(ops, { runId, sessionKey, stopReason, partialText });
  ops.agentRunSeq.delete(runId);
  if (removed?.clientRunId) {
    ops.agentRunSeq.delete(removed.clientRunId);
  }
  return { aborted: true };
}

// Wires the `requestSessionRunCancel` seam so plugin-owned delegated tasks
// can trigger a real core abort for the owning OpenClaw run without any
// plugin-specific branching in core. Returns a disposer that removes the
// requester (idempotent, safe to call during shutdown).
export function wireSessionRunCancelRequester(ops: ChatAbortOps): () => void {
  return setSessionRunAbortRequester((target, reason) => {
    const { aborted } = abortChatRunById(ops, {
      runId: target.runId,
      sessionKey: target.sessionKey,
      ...(reason?.message ? { stopReason: reason.message } : {}),
    });
    return aborted;
  });
}

export function abortChatRunsForSessionKey(
  ops: ChatAbortOps,
  params: {
    sessionKey: string;
    stopReason?: string;
  },
): { aborted: boolean; runIds: string[] } {
  const { sessionKey, stopReason } = params;
  const runIds: string[] = [];
  for (const [runId, active] of ops.chatAbortControllers) {
    if (active.sessionKey !== sessionKey) {
      continue;
    }
    const res = abortChatRunById(ops, { runId, sessionKey, stopReason });
    if (res.aborted) {
      runIds.push(runId);
    }
  }
  return { aborted: runIds.length > 0, runIds };
}
