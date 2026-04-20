import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __testing as sessionRunCancelTesting,
  onSessionRunCancel,
  requestSessionRunCancel,
} from "../sessions/session-run-cancel.js";
import {
  abortChatRunById,
  isChatStopCommandText,
  wireSessionRunCancelRequester,
  type ChatAbortOps,
  type ChatAbortControllerEntry,
} from "./chat-abort.js";

function createActiveEntry(sessionKey: string): ChatAbortControllerEntry {
  const now = Date.now();
  return {
    controller: new AbortController(),
    sessionId: "sess-1",
    sessionKey,
    startedAtMs: now,
    expiresAtMs: now + 10_000,
  };
}

function createOps(params: {
  runId: string;
  entry: ChatAbortControllerEntry;
  buffer?: string;
}): ChatAbortOps & {
  broadcast: ReturnType<typeof vi.fn>;
  nodeSendToSession: ReturnType<typeof vi.fn>;
  removeChatRun: ReturnType<typeof vi.fn>;
} {
  const { runId, entry, buffer } = params;
  const broadcast = vi.fn();
  const nodeSendToSession = vi.fn();
  const removeChatRun = vi.fn();

  return {
    chatAbortControllers: new Map([[runId, entry]]),
    chatRunBuffers: new Map(buffer !== undefined ? [[runId, buffer]] : []),
    chatDeltaSentAt: new Map([[runId, Date.now()]]),
    chatDeltaLastBroadcastLen: new Map([[runId, buffer?.length ?? 0]]),
    chatAbortedRuns: new Map(),
    removeChatRun,
    agentRunSeq: new Map(),
    broadcast,
    nodeSendToSession,
  };
}

describe("isChatStopCommandText", () => {
  it("matches slash and standalone multilingual stop forms", () => {
    expect(isChatStopCommandText(" /STOP!!! ")).toBe(true);
    expect(isChatStopCommandText("stop please")).toBe(true);
    expect(isChatStopCommandText("do not do that")).toBe(true);
    expect(isChatStopCommandText("停止")).toBe(true);
    expect(isChatStopCommandText("やめて")).toBe(true);
    expect(isChatStopCommandText("توقف")).toBe(true);
    expect(isChatStopCommandText("остановись")).toBe(true);
    expect(isChatStopCommandText("halt")).toBe(true);
    expect(isChatStopCommandText("stopp")).toBe(true);
    expect(isChatStopCommandText("pare")).toBe(true);
    expect(isChatStopCommandText("/status")).toBe(false);
    expect(isChatStopCommandText("please do not do that")).toBe(false);
    expect(isChatStopCommandText("keep going")).toBe(false);
  });
});

describe("abortChatRunById", () => {
  afterEach(() => {
    sessionRunCancelTesting.reset();
  });

  it("broadcasts aborted payload with partial message when buffered text exists", () => {
    const runId = "run-1";
    const sessionKey = "main";
    const entry = createActiveEntry(sessionKey);
    const ops = createOps({ runId, entry, buffer: "  Partial reply  " });
    ops.agentRunSeq.set(runId, 2);
    ops.agentRunSeq.set("client-run-1", 4);
    ops.removeChatRun.mockReturnValue({ sessionKey, clientRunId: "client-run-1" });

    const result = abortChatRunById(ops, { runId, sessionKey, stopReason: "user" });

    expect(result).toEqual({ aborted: true });
    expect(entry.controller.signal.aborted).toBe(true);
    expect(ops.chatAbortControllers.has(runId)).toBe(false);
    expect(ops.chatRunBuffers.has(runId)).toBe(false);
    expect(ops.chatDeltaSentAt.has(runId)).toBe(false);
    expect(ops.chatDeltaLastBroadcastLen.has(runId)).toBe(false);
    expect(ops.removeChatRun).toHaveBeenCalledWith(runId, runId, sessionKey);
    expect(ops.agentRunSeq.has(runId)).toBe(false);
    expect(ops.agentRunSeq.has("client-run-1")).toBe(false);

    expect(ops.broadcast).toHaveBeenCalledTimes(1);
    const payload = ops.broadcast.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(payload).toEqual(
      expect.objectContaining({
        runId,
        sessionKey,
        seq: 3,
        state: "aborted",
        stopReason: "user",
      }),
    );
    expect(payload.message).toEqual(
      expect.objectContaining({
        role: "assistant",
        content: [{ type: "text", text: "  Partial reply  " }],
      }),
    );
    expect((payload.message as { timestamp?: unknown }).timestamp).toEqual(expect.any(Number));
    expect(ops.nodeSendToSession).toHaveBeenCalledWith(sessionKey, "chat", payload);
  });

  it("omits aborted message when buffered text is empty", () => {
    const runId = "run-1";
    const sessionKey = "main";
    const entry = createActiveEntry(sessionKey);
    const ops = createOps({ runId, entry, buffer: "   " });

    const result = abortChatRunById(ops, { runId, sessionKey });

    expect(result).toEqual({ aborted: true });
    const payload = ops.broadcast.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(payload.message).toBeUndefined();
  });

  it("fans out cancel to delegated-task handlers registered for the session_run target", () => {
    const runId = "run-1";
    const sessionKey = "main";
    const entry = createActiveEntry(sessionKey);
    const ops = createOps({ runId, entry });
    const handler = vi.fn();
    onSessionRunCancel({ kind: "session_run", sessionKey, runId }, handler);

    abortChatRunById(ops, { runId, sessionKey, stopReason: "user" });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(
      { kind: "session_run", sessionKey, runId },
      { source: "chat-abort", message: "user" },
    );
  });

  it("does not fan out when the abort no-ops because no controller is tracked", () => {
    const runId = "run-1";
    const sessionKey = "main";
    const entry = createActiveEntry(sessionKey);
    const ops = createOps({ runId, entry });
    ops.chatAbortControllers.clear();
    const handler = vi.fn();
    onSessionRunCancel({ kind: "session_run", sessionKey, runId }, handler);

    const result = abortChatRunById(ops, { runId, sessionKey });

    expect(result).toEqual({ aborted: false });
    expect(handler).not.toHaveBeenCalled();
  });

  it("wires requestSessionRunCancel to abortChatRunById for matching runs", async () => {
    const runId = "run-1";
    const sessionKey = "main";
    const entry = createActiveEntry(sessionKey);
    const ops = createOps({ runId, entry });
    const dispose = wireSessionRunCancelRequester(ops);

    const result = await requestSessionRunCancel(
      { kind: "session_run", sessionKey, runId },
      { source: "plugin:test", message: "cancelled" },
    );

    expect(result).toEqual({ requested: true, aborted: true });
    expect(entry.controller.signal.aborted).toBe(true);
    const payload = ops.broadcast.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(payload.stopReason).toBe("cancelled");

    dispose();
  });

  it("reports aborted=false when no active run matches the requester", async () => {
    const runId = "run-1";
    const sessionKey = "main";
    const entry = createActiveEntry(sessionKey);
    const ops = createOps({ runId, entry });
    ops.chatAbortControllers.clear();
    const dispose = wireSessionRunCancelRequester(ops);

    const result = await requestSessionRunCancel({
      kind: "session_run",
      sessionKey,
      runId,
    });

    expect(result).toEqual({ requested: true, aborted: false });
    dispose();
  });

  it("unwires the requester on disposer so later requests report requested=false", async () => {
    const runId = "run-1";
    const sessionKey = "main";
    const entry = createActiveEntry(sessionKey);
    const ops = createOps({ runId, entry });
    const dispose = wireSessionRunCancelRequester(ops);
    dispose();

    const result = await requestSessionRunCancel({
      kind: "session_run",
      sessionKey,
      runId,
    });

    expect(result).toEqual({ requested: false, aborted: false });
    expect(entry.controller.signal.aborted).toBe(false);
  });

  it("preserves partial message even when abort listeners clear buffers synchronously", () => {
    const runId = "run-1";
    const sessionKey = "main";
    const entry = createActiveEntry(sessionKey);
    const ops = createOps({ runId, entry, buffer: "streamed text" });

    // Simulate synchronous cleanup triggered by AbortController listeners.
    entry.controller.signal.addEventListener("abort", () => {
      ops.chatRunBuffers.delete(runId);
    });

    const result = abortChatRunById(ops, { runId, sessionKey });

    expect(result).toEqual({ aborted: true });
    const payload = ops.broadcast.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(payload.message).toEqual(
      expect.objectContaining({
        role: "assistant",
        content: [{ type: "text", text: "streamed text" }],
      }),
    );
  });
});
