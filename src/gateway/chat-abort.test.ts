// Chat abort tests protect in-flight run tracking, stop-command parsing, provider
// abort fanout, history snapshots, and cleanup of buffered streaming state.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatEvent } from "../../packages/gateway-protocol/src/schema/logs-chat.js";
import { createOperationalRunInstanceRef } from "../agents/admitted-run-context.js";
import { isAgentRunRestartAbortReason } from "../agents/run-termination.js";
import { onAgentEvent } from "../infra/agent-events.js";
import {
  claimAgentRunDelegatedAuthority,
  clearAgentRunContext,
  registerAgentRunContext,
  releaseAgentRunDelegatedAuthority,
  resetAgentRunRegistryForTest,
  validateAgentRunDelegatedAuthority,
} from "../infra/agent-run-registry.js";
import {
  abortChatRunById,
  abortChatRunsForProvider,
  registerChatAbortController,
  resolveAgentRunExpiresAtMs,
  resolveChatRunExpiresAtMs,
  type ChatAbortOps,
  type ChatAbortControllerEntry,
  updateChatRunProvider,
} from "./chat-abort.js";
import type { ChatCanvasBlock } from "./chat-display-projection.canvas.js";
import { createChatRunState } from "./server-chat-state.js";

type CreatedChatAbortOps = ChatAbortOps & {
  broadcast: ReturnType<typeof vi.fn>;
  nodeSendToSession: ReturnType<typeof vi.fn>;
  removeChatRun: ReturnType<typeof vi.fn>;
};

afterEach(() => {
  vi.useRealTimers();
});

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
}): CreatedChatAbortOps {
  const { runId, entry, buffer } = params;
  const broadcast = vi.fn();
  const nodeSendToSession = vi.fn();
  const removeChatRun = vi.fn();
  const chatRunState = createChatRunState();
  chatRunState.updateBuffer(runId, { delta: buffer ?? "" });
  chatRunState.takeBufferDelta(runId, buffer ?? "");
  Object.assign(chatRunState.getOrCreate(runId), {
    deltaSentAt: Date.now(),
    assistantScope: { itemId: "assistant-1", prefix: "", boundaryNewlines: 0, separatorLength: 0 },
    agentText: {
      assistant: {
        lastSentAt: Date.now(),
        bufferedEvent: {
          payload: {
            runId,
            seq: 1,
            stream: "assistant",
            ts: Date.now(),
            data: { text: "buffer", delta: "buffer" },
          },
        },
      },
    },
  });

  return {
    chatAbortControllers: new Map([[runId, entry]]),
    chatRunState,
    removeChatRun,
    agentRunSeq: new Map(),
    broadcast,
    nodeSendToSession,
  };
}

function createAbortRunFixture(params: {
  runId?: string;
  sessionKey?: string;
  entry?: ChatAbortControllerEntry;
  buffer?: string;
  now?: Date;
}): {
  runId: string;
  sessionKey: string;
  entry: ChatAbortControllerEntry;
  ops: CreatedChatAbortOps;
} {
  const runId = params.runId ?? "run-1";
  const sessionKey = params.sessionKey ?? "main";
  if (params.now) {
    vi.useFakeTimers();
    vi.setSystemTime(params.now);
  }
  const entry = params.entry ?? createActiveEntry(sessionKey);
  const ops = createOps({ runId, entry, buffer: params.buffer });
  return { runId, sessionKey, entry, ops };
}

function firstBroadcastPayload(ops: { broadcast: ReturnType<typeof vi.fn> }): unknown {
  const call = ops.broadcast.mock.calls[0];
  if (!call) {
    throw new Error("expected broadcast call");
  }
  return call[1];
}

function expectRunAborted(params: {
  result: ReturnType<typeof abortChatRunById>;
  entry: ChatAbortControllerEntry;
  ops: ChatAbortOps;
  runId: string;
}): void {
  expect(params.result).toEqual({ aborted: true });
  expect(params.entry.controller.signal.aborted).toBe(true);
  expect(params.ops.chatAbortControllers.has(params.runId)).toBe(false);
}

describe("registerChatAbortController", () => {
  it.each([
    [Number.NaN, undefined, 0],
    [1_800_000_000_000, Number.POSITIVE_INFINITY, 1_800_000_000_000],
  ] as const)(
    "expires registrations for invalid clock %s or expiry %s",
    (now, expiresAtMs, startedAtMs) => {
      const chatAbortControllers = new Map<string, ChatAbortControllerEntry>();
      const registration = registerChatAbortController({
        chatAbortControllers,
        runId: "run-invalid-time",
        sessionId: "sess-1",
        sessionKey: "main",
        timeoutMs: 60_000,
        now,
        expiresAtMs,
      });

      expect(registration.registered).toBe(true);
      expect(registration.entry).toMatchObject({ startedAtMs, expiresAtMs: 0 });
      expect(chatAbortControllers.get("run-invalid-time")?.expiresAtMs).toBe(0);
    },
  );

  it("bounds default and agent run expiry calculations to valid Date timestamps", () => {
    expect(resolveChatRunExpiresAtMs({ now: Number.NaN, timeoutMs: 60_000 })).toBe(0);
    expect(resolveChatRunExpiresAtMs({ now: 8_640_000_000_000_000, timeoutMs: 60_000 })).toBe(0);
    expect(resolveAgentRunExpiresAtMs({ now: Number.NaN, timeoutMs: 60_000 })).toBe(0);
  });

  it("re-arms agent expiry from execution admission exactly once", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_800_000_000_000);
    const chatAbortControllers = new Map<string, ChatAbortControllerEntry>();
    const registration = registerChatAbortController({
      chatAbortControllers,
      runId: "run-queued-agent",
      sessionId: "sess-1",
      sessionKey: "main",
      timeoutMs: 120_000,
      kind: "agent",
    });
    const startedAtMs = registration.entry?.startedAtMs;

    vi.advanceTimersByTime(90_000);
    registration.markExecutionStarted();
    const executionExpiresAtMs = resolveAgentRunExpiresAtMs({
      now: Date.now(),
      timeoutMs: 120_000,
    });

    expect(registration.entry?.startedAtMs).toBe(startedAtMs);
    expect(registration.entry?.expiresAtMs).toBe(executionExpiresAtMs);

    vi.advanceTimersByTime(30_000);
    registration.markExecutionStarted();
    expect(registration.entry?.expiresAtMs).toBe(executionExpiresAtMs);
  });

  it("does not re-arm an agent after its unswept queue deadline", () => {
    vi.useFakeTimers();
    for (const [runId, offsetMs] of [
      ["run-agent-at-queue-deadline", 0],
      ["run-agent-after-queue-deadline", 1],
    ] as const) {
      vi.setSystemTime(1_800_000_000_000);
      const chatAbortControllers = new Map<string, ChatAbortControllerEntry>();
      const registration = registerChatAbortController({
        chatAbortControllers,
        runId,
        sessionId: "sess-1",
        sessionKey: "main",
        timeoutMs: 120_000,
        kind: "agent",
      });
      const queueExpiresAtMs = registration.entry?.expiresAtMs;
      const startedAtMs = registration.entry?.startedAtMs;
      expect(queueExpiresAtMs).toBeTypeOf("number");

      vi.setSystemTime((queueExpiresAtMs as number) + offsetMs);
      registration.markExecutionStarted();
      registration.markExecutionStarted();

      expect(registration.entry?.startedAtMs).toBe(startedAtMs);
      expect(registration.entry?.expiresAtMs).toBe(queueExpiresAtMs);
      expect(registration.controller.signal.aborted).toBe(false);
    }
  });

  it.each(["stale", "aborted", "chat-send"] as const)(
    "does not re-arm %s registrations",
    (state) => {
      vi.useFakeTimers();
      vi.setSystemTime(1_800_000_000_000);
      const chatAbortControllers = new Map<string, ChatAbortControllerEntry>();
      const registration = registerChatAbortController({
        chatAbortControllers,
        runId: "run-expiry",
        sessionId: "sess-1",
        sessionKey: "main",
        timeoutMs: 60_000,
        kind: state === "chat-send" ? state : "agent",
      });
      const expiry = registration.entry?.expiresAtMs;
      if (state === "stale") {
        chatAbortControllers.delete("run-expiry");
      } else if (state === "aborted") {
        registration.controller.abort();
      }
      vi.advanceTimersByTime(30_000);
      registration.markExecutionStarted();
      expect(registration.entry?.expiresAtMs).toBe(expiry);
    },
  );

  it("retains registrations when terminal lifecycle was observed before caller cleanup", () => {
    const chatAbortControllers = new Map<string, ChatAbortControllerEntry>();
    const registration = registerChatAbortController({
      chatAbortControllers,
      runId: "run-awaiting-terminal",
      sessionId: "sess-1",
      sessionKey: "main",
      timeoutMs: 60_000,
    });

    if (!registration.entry) {
      throw new Error("expected registered entry");
    }
    registration.entry.projectSessionTerminalPending = true;
    registration.cleanup();

    expect(chatAbortControllers.has("run-awaiting-terminal")).toBe(true);
    expect(registration.entry?.registrationCleanupRequested).toBe(true);
  });
});

describe("abortChatRunById", () => {
  it("retains terminal persistence ownership observed during abort", () => {
    const { runId, sessionKey, entry, ops } = createAbortRunFixture({});
    let terminalEvents = 0;
    const unsubscribe = onAgentEvent((event) => {
      if (event.runId === runId && event.stream === "lifecycle" && event.data.phase === "end") {
        terminalEvents += 1;
        entry.projectSessionTerminalPending = true;
        entry.projectSessionTerminalObservedAt = event.ts;
      }
    });

    try {
      const result = abortChatRunById(ops, { runId, sessionKey, stopReason: "user" });

      expect(result).toEqual({ aborted: true });
      expect(entry.controller.signal.aborted).toBe(true);
      expect(entry.projectSessionActive).toBe(false);
      expect(entry.registrationCleanupRequested).toBe(true);
      expect(entry.projectSessionTerminalPending).toBe(true);
      expect(entry.projectSessionTerminalObservedAt).toEqual(expect.any(Number));
      expect(ops.chatAbortControllers.get(runId)).toBe(entry);

      expect(abortChatRunById(ops, { runId, sessionKey, stopReason: "user" })).toEqual({
        aborted: false,
      });
      expect(terminalEvents).toBe(1);
      expect(ops.broadcast).toHaveBeenCalledOnce();
      expect(ops.removeChatRun).toHaveBeenCalledOnce();
    } finally {
      unsubscribe();
    }
  });

  it("preserves the owning session identity when synchronous abort cleanup clears run context", () => {
    const { runId, sessionKey, entry, ops } = createAbortRunFixture({
      runId: "run-pre-reset-abort",
    });
    registerAgentRunContext(runId, { sessionKey, sessionId: entry.sessionId });
    entry.controller.signal.addEventListener("abort", () => clearAgentRunContext(runId));
    const events: Array<{ sessionId?: string }> = [];
    const unsubscribe = onAgentEvent((event) => {
      if (event.runId === runId && event.stream === "lifecycle") {
        events.push({ sessionId: event.sessionId });
      }
    });

    try {
      expect(abortChatRunById(ops, { runId, sessionKey, stopReason: "rpc" })).toEqual({
        aborted: true,
      });
      expect(events).toEqual([{ sessionId: entry.sessionId }]);
    } finally {
      unsubscribe();
      clearAgentRunContext(runId);
    }
  });

  it("broadcasts aborted payload with partial message when buffered text exists", () => {
    const now = new Date("2026-01-02T03:04:05.000Z");
    const { runId, sessionKey, entry, ops } = createAbortRunFixture({
      buffer: "  Partial reply  ",
      now,
    });
    ops.agentRunSeq.set(runId, 2);
    ops.agentRunSeq.set("client-run-1", 4);
    ops.removeChatRun.mockReturnValue({ sessionKey, clientRunId: "client-run-1" });

    const result = abortChatRunById(ops, { runId, sessionKey, stopReason: "user" });

    expectRunAborted({ result, entry, ops, runId });
    expect(ops.chatRunState.runs.get(runId)?.buffer).toBeUndefined();
    expect(ops.chatRunState.runs.get(runId)?.deltaSentAt).toBeUndefined();
    expect(ops.chatRunState.runs.get(runId)?.assistantScope).toBeUndefined();
    expect(ops.chatRunState.runs.get(runId)?.display).toBeUndefined();
    expect(ops.chatRunState.runs.get(runId)?.agentText).toBeUndefined();
    expect(ops.removeChatRun).toHaveBeenCalledWith(runId, runId, sessionKey);
    expect(ops.agentRunSeq.has(runId)).toBe(false);
    expect(ops.agentRunSeq.has("client-run-1")).toBe(false);

    expect(ops.broadcast).toHaveBeenCalledTimes(1);
    const payload = firstBroadcastPayload(ops) as ChatEvent;
    expect(payload).toEqual({
      runId,
      sessionKey,
      seq: 3,
      state: "aborted",
      stopReason: "user",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "  Partial reply  " }],
        timestamp: now.getTime(),
      },
    });
    expect(ops.nodeSendToSession).toHaveBeenCalledWith(sessionKey, "chat", payload);
  });

  it("includes the active run's safe validation diagnostic", () => {
    const runId = "run-validation-abort";
    const sessionKey = "main";
    const entry = {
      ...createActiveEntry(sessionKey),
      toolErrorSummary: "edit tool validation failed: edits: must be an array",
    };
    const ops = createOps({ runId, entry });

    abortChatRunById(ops, { runId, sessionKey, stopReason: "user" });

    expect(firstBroadcastPayload(ops)).toMatchObject({
      runId,
      state: "aborted",
      errorMessage: "edit tool validation failed: edits: must be an array",
    });
  });

  it("aborts hidden internal runs without broadcasting chat events", () => {
    const sessionKey = "main";
    const { runId, entry, ops } = createAbortRunFixture({
      runId: "run-hidden",
      sessionKey,
      entry: { ...createActiveEntry(sessionKey), controlUiVisible: false },
      buffer: "hidden partial",
    });

    const result = abortChatRunById(ops, { runId, sessionKey, stopReason: "timeout" });

    expectRunAborted({ result, entry, ops, runId });
    expect(ops.broadcast).not.toHaveBeenCalled();
    expect(ops.nodeSendToSession).not.toHaveBeenCalled();
  });

  for (const testCase of [
    {
      name: "fans out default-agent global aborts to scoped and legacy global subscribers",
      runId: "run-main-global",
      createEntry: () => ({ ...createActiveEntry("global"), agentId: "main" }),
      abort: abortChatRunById,
    },
    {
      name: "resolves unscoped global aborts to the default agent subscribers",
      runId: "run-unscoped-global",
      createEntry: () => createActiveEntry("global"),
      abort: abortChatRunById,
    },
  ]) {
    it(testCase.name, () => {
      const ops = createOps({ runId: testCase.runId, entry: testCase.createEntry() });
      ops.getRuntimeConfig = () => ({ agents: { entries: { main: {} } } });

      const result = testCase.abort(ops, { runId: testCase.runId, sessionKey: "global" });

      expect(result).toEqual({ aborted: true });
      const payload = firstBroadcastPayload(ops) as ChatEvent;
      expect(payload.agentId).toBe("main");
      const delivery = { sessionKeys: ["agent:main:global", "global"] };
      expect(ops.broadcast).toHaveBeenCalledWith("chat", payload, delivery);
      expect(ops.nodeSendToSession).toHaveBeenCalledWith("agent:main:global", "chat", payload);
      expect(ops.nodeSendToSession).toHaveBeenCalledWith("global", "chat", payload);
    });
  }

  it("tags maintenance timeouts as timeout abort reasons", () => {
    const { runId, sessionKey, entry, ops } = createAbortRunFixture({ runId: "run-timeout" });

    const result = abortChatRunById(ops, { runId, sessionKey, stopReason: "timeout" });

    expect(result).toEqual({ aborted: true });
    expect(entry.abortStopReason).toBe("timeout");
    expect(entry.controller.signal.aborted).toBe(true);
    expect(entry.controller.signal.reason).toBeInstanceOf(Error);
    expect((entry.controller.signal.reason as Error).name).toBe("TimeoutError");
  });

  it("tags restart abort signals with a restart-specific reason", () => {
    const { runId, sessionKey, entry, ops } = createAbortRunFixture({ runId: "run-restart" });

    const result = abortChatRunById(ops, { runId, sessionKey, stopReason: "restart" });

    expect(result).toEqual({ aborted: true });
    expect(isAgentRunRestartAbortReason(entry.controller.signal.reason)).toBe(true);
  });

  it.each([
    ["streamed text", true, true],
    ["", true, true],
    ["NO_REPLY", true, false],
    ["stale text", false, false],
  ] as const)(
    "snapshots completed widgets before synchronous abort cleanup (%j, current=%j)",
    (buffer, current, visible) => {
      let ownsBuffer = current;
      const now = new Date("2026-01-02T03:04:05.000Z");
      const { runId, sessionKey, entry, ops } = createAbortRunFixture({
        buffer,
        now,
      });
      const widget: ChatCanvasBlock = {
        type: "canvas",
        preview: {
          kind: "canvas",
          surface: "assistant_message",
          render: "url",
          url: "/__openclaw__/canvas/documents/finished/index.html",
          viewId: "finished",
          sandbox: "scripts",
        },
        rawText: null,
      };
      Object.assign(ops.chatRunState.getOrCreate(runId), {
        canvasBlocks: [widget],
        bufferIsCurrent: () => ownsBuffer,
      });

      entry.controller.signal.addEventListener("abort", () => {
        ownsBuffer = false;
        ops.chatRunState.clearRun(runId);
      });

      const result = abortChatRunById(ops, { runId, sessionKey });

      expect(result).toEqual({ aborted: true });
      const payload = firstBroadcastPayload(ops) as ChatEvent;
      expect(payload).toEqual({
        runId,
        sessionKey,
        seq: 1,
        state: "aborted",
        stopReason: undefined,
        message: visible
          ? {
              role: "assistant",
              content: [...(buffer ? [{ type: "text", text: buffer }] : []), widget],
              timestamp: now.getTime(),
            }
          : undefined,
      });
      expect(ops.nodeSendToSession).toHaveBeenCalledWith(sessionKey, "chat", payload);
      expect(ops.chatRunState.runs.get(runId)?.canvasBlocks).toBeUndefined();
    },
  );
});

describe("abortChatRunsForProvider", () => {
  it("uses updated provider metadata after model fallback", () => {
    const runId = "run-1";
    const sessionKey = "main";
    const entry = createActiveEntry(sessionKey);
    entry.providerId = "openai";
    entry.authProviderId = "openai";
    const ops = createOps({ runId, entry });

    const updated = updateChatRunProvider(ops.chatAbortControllers, {
      runId,
      providerId: "openrouter",
      authProviderId: "openrouter",
    });
    const result = abortChatRunsForProvider(ops, {
      cfg: { agents: { entries: { main: {}, writer: {} } } },
      providerId: "openrouter",
      stopReason: "auth-revoked",
    });

    expect(updated).toBe(true);
    expect(result.runIds).toEqual([runId]);
    expect(entry.controller.signal.aborted).toBe(true);
    expect(ops.broadcast).toHaveBeenCalledWith(
      "chat",
      expect.objectContaining({
        runId,
        state: "aborted",
        stopReason: "auth-revoked",
      }),
      { sessionKeys: [sessionKey] },
    );
  });

  it("derives missing entry agent ids from canonical session keys", () => {
    const writerEntry = createActiveEntry("agent:writer:main");
    writerEntry.providerId = "openrouter";
    const mainEntry = createActiveEntry("agent:main:main");
    mainEntry.providerId = "openrouter";
    const ops = createOps({ runId: "run-writer", entry: writerEntry });
    ops.chatAbortControllers.set("run-main", mainEntry);

    const result = abortChatRunsForProvider(ops, {
      cfg: { agents: { entries: { main: {}, writer: {} } } },
      providerId: "openrouter",
      agentId: "writer",
      stopReason: "auth-revoked",
    });

    expect(result.runIds).toEqual(["run-writer"]);
    expect(writerEntry.controller.signal.aborted).toBe(true);
    expect(mainEntry.controller.signal.aborted).toBe(false);
  });
});

describe("chat abort delegated authority", () => {
  beforeEach(() => {
    resetAgentRunRegistryForTest();
  });
  function createAuthorityAbortFixture(runId: string) {
    const sessionKey = "agent:main:authority";
    const operationalRunInstance = createOperationalRunInstanceRef(runId);
    const chatAbortControllers = new Map<string, ChatAbortControllerEntry>();
    const registration = registerChatAbortController({
      chatAbortControllers,
      runId,
      sessionId: `session-${runId}`,
      sessionKey,
      timeoutMs: 60_000,
      operationalRunInstance,
    });
    const authority = claimAgentRunDelegatedAuthority(operationalRunInstance);
    registration.bindAgentRunDelegatedAuthority(authority);
    const chatRunState = createChatRunState();
    const ops: ChatAbortOps = {
      chatAbortControllers,
      chatRunState,
      removeChatRun: vi.fn(() => undefined),
      agentRunSeq: new Map(),
      broadcast: vi.fn(),
      nodeSendToSession: vi.fn(),
    };
    return {
      authority,
      operationalRunInstance,
      chatRunState,
      ops,
      registration,
      runId,
      sessionKey,
    };
  }

  it("binds delegated authority only to the exact operational instance object", () => {
    const { authority, operationalRunInstance, registration } =
      createAuthorityAbortFixture("run-exact-authority");

    expect(registration.entry?.agentRunDelegatedAuthority).toBe(authority);
    expect(registration.entry?.operationalRunInstance).toBe(operationalRunInstance);
    expect(() =>
      registration.bindAgentRunDelegatedAuthority({
        ...authority,
        operationalRunInstance: Object.freeze({ ...operationalRunInstance }),
      }),
    ).toThrow("does not belong to this controller registration");

    registration.cleanup();
    expect(validateAgentRunDelegatedAuthority(authority)).toBe(false);
  });

  it("leaves sessionless authority with the outer admission owner", () => {
    const runId = "run-sessionless-authority";
    const operationalRunInstance = createOperationalRunInstanceRef(runId);
    const chatAbortControllers = new Map<string, ChatAbortControllerEntry>();
    const registration = registerChatAbortController({
      chatAbortControllers,
      runId,
      sessionId: `session-${runId}`,
      timeoutMs: 60_000,
      operationalRunInstance,
    });
    const authority = claimAgentRunDelegatedAuthority(operationalRunInstance);
    const unrelatedInstance = createOperationalRunInstanceRef("run-unrelated-authority");
    const unrelatedAuthority = claimAgentRunDelegatedAuthority(unrelatedInstance);

    expect(registration.registered).toBe(false);
    expect(chatAbortControllers).toHaveLength(0);
    expect(() => registration.bindAgentRunDelegatedAuthority(authority)).toThrow(
      "does not belong to this controller registration",
    );
    expect(() => registration.bindAgentRunDelegatedAuthority(unrelatedAuthority)).toThrow(
      "does not belong to this controller registration",
    );

    registration.cleanup();
    expect(validateAgentRunDelegatedAuthority(authority)).toBe(true);
    expect(validateAgentRunDelegatedAuthority(unrelatedAuthority)).toBe(true);
    expect(releaseAgentRunDelegatedAuthority(authority)).toBe(true);
    expect(releaseAgentRunDelegatedAuthority(unrelatedAuthority)).toBe(true);
  });

  it("revokes exact delegated authority before abort callbacks and controller listeners", () => {
    const { authority, chatRunState, ops, registration, runId, sessionKey } =
      createAuthorityAbortFixture("run-authority-abort");
    const entry = registration.entry!;
    const onAbortCommitted = vi.fn(() => {
      expect(validateAgentRunDelegatedAuthority(authority)).toBe(true);
      expect(entry.controller.signal.aborted).toBe(false);
      expect(chatRunState.hasAbortMarker(runId)).toBe(true);
    });
    ops.onRunAborted = vi.fn(() => {
      expect(validateAgentRunDelegatedAuthority(authority)).toBe(false);
      expect(entry.controller.signal.aborted).toBe(false);
    });

    entry.isAbortable = () => false;
    chatRunState.getOrCreate(runId).buffer = "completed reply";
    expect(abortChatRunById(ops, { runId, sessionKey, onAbortCommitted })).toEqual({
      aborted: false,
    });
    expect(onAbortCommitted).not.toHaveBeenCalled();
    expect(validateAgentRunDelegatedAuthority(authority)).toBe(true);
    expect(entry.controller.signal.aborted).toBe(false);
    expect(ops.chatAbortControllers.get(runId)).toBe(entry);
    expect(chatRunState.runs.get(runId)?.buffer).toBe("completed reply");
    expect(chatRunState.hasAbortMarker(runId)).toBe(false);
    expect(ops.removeChatRun).not.toHaveBeenCalled();
    expect(ops.broadcast).not.toHaveBeenCalled();
    expect(ops.nodeSendToSession).not.toHaveBeenCalled();
    entry.isAbortable = undefined;

    expect(
      abortChatRunById(ops, { runId, sessionKey, stopReason: "user", onAbortCommitted }),
    ).toEqual({
      aborted: true,
    });
    expect(ops.onRunAborted).toHaveBeenCalledOnce();
    expect(entry.controller.signal.aborted).toBe(true);
    expect(abortChatRunById(ops, { runId, sessionKey, onAbortCommitted })).toEqual({
      aborted: false,
    });
    expect(onAbortCommitted).toHaveBeenCalledOnce();
  });

  it("does not revoke a same-id successor from a stale abort controller", () => {
    const { ops, runId, sessionKey } = createAuthorityAbortFixture("run-authority-successor");
    const successorInstance = createOperationalRunInstanceRef(runId);
    const successor = claimAgentRunDelegatedAuthority(successorInstance);

    expect(abortChatRunById(ops, { runId, sessionKey, stopReason: "stale" })).toEqual({
      aborted: true,
    });
    expect(validateAgentRunDelegatedAuthority(successor)).toBe(true);
    expect(releaseAgentRunDelegatedAuthority(successor)).toBe(true);
  });
});
