import { describe, expect, it, vi } from "vitest";
import {
  abortChatRunById,
  isChatStopCommandText,
  type ChatAbortOps,
  type ChatAbortControllerEntry,
} from "./chat-abort.js";
import { createChatRunState } from "./server-chat.js";

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
  chatRunState?: ReturnType<typeof createChatRunState>;
}): ChatAbortOps & {
  broadcast: ReturnType<typeof vi.fn>;
  nodeSendToSession: ReturnType<typeof vi.fn>;
  removeChatRun: ReturnType<typeof vi.fn>;
} {
  const { runId, entry, buffer, chatRunState = createChatRunState() } = params;
  const broadcast = vi.fn();
  const nodeSendToSession = vi.fn();
  const removeChatRun = vi.fn();
  if (buffer !== undefined) {
    chatRunState.buffers.set(runId, buffer);
  }
  chatRunState.deltaSentAt.set(runId, Date.now());

  return {
    chatAbortControllers: new Map([[runId, entry]]),
    chatAbortedRuns: chatRunState.abortedRuns,
    chatRunState,
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
    expect(ops.chatRunState.buffers.has(runId)).toBe(false);
    expect(ops.chatRunState.deltaSentAt.has(runId)).toBe(false);
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

  it("preserves partial message even when abort listeners clear buffers synchronously", () => {
    const runId = "run-1";
    const sessionKey = "main";
    const entry = createActiveEntry(sessionKey);
    const ops = createOps({ runId, entry, buffer: "streamed text" });

    // Simulate synchronous cleanup triggered by AbortController listeners.
    entry.controller.signal.addEventListener("abort", () => {
      ops.chatRunState.buffers.delete(runId);
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

  it("clears effective-run recovery state so a reused key starts fresh after abort teardown", () => {
    const runId = "retry-run";
    const sessionKey = "main";
    const entry = createActiveEntry(sessionKey);
    const chatRunState = createChatRunState();
    chatRunState.buffers.set(runId, "Hello");
    chatRunState.lastSeenEventSeq.set(runId, 3);
    chatRunState.lastAcceptedSeq.set(runId, 1);
    chatRunState.waitingForRecovery.add(runId);
    chatRunState.deltaSentAt.set(runId, 10);
    chatRunState.deltaLastBroadcastLen.set(runId, 5);
    const ops = createOps({ runId, entry, buffer: "Hello", chatRunState });

    const result = abortChatRunById(ops, { runId, sessionKey });

    expect(result).toEqual({ aborted: true });
    expect(chatRunState.buffers.has(runId)).toBe(false);
    expect(chatRunState.lastSeenEventSeq.has(runId)).toBe(false);
    expect(chatRunState.lastAcceptedSeq.has(runId)).toBe(false);
    expect(chatRunState.waitingForRecovery.has(runId)).toBe(false);
    expect(chatRunState.deltaSentAt.has(runId)).toBe(false);
    expect(chatRunState.deltaLastBroadcastLen.has(runId)).toBe(false);
  });
});
