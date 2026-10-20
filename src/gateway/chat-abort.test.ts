import { randomUUID } from "node:crypto";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { Value } from "typebox/value";
// Chat abort tests protect in-flight run tracking, stop-command parsing, provider
// abort fanout, history snapshots, and cleanup of buffered streaming state.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ChatEventSchema,
  type ChatEvent,
} from "../../packages/gateway-protocol/src/schema/logs-chat.js";
import {
  isAgentRunDirectAbortReason,
  isAgentRunRestartAbortReason,
} from "../agents/run-termination.js";
import { emitAgentEvent, onAgentEvent, onAgentRuntimeEvent } from "../infra/agent-events.js";
import {
  clearAgentRunContext,
  getAgentRunContext,
  registerAgentRunContext,
} from "../infra/agent-run-registry.js";
import { captureSessionTarget } from "../sessions/session-controller.lifecycle.js";
import {
  claimSessionControllerTask,
  releaseSessionControllerClaim,
  reserveSessionControllerSource,
} from "../sessions/session-controller.mailbox.js";
import { createReplyOperation } from "../sessions/session-controller.operation.js";
import {
  getRpcSourceIdentity,
  getRpcSourceProjectSessionActive,
  getRpcSourceStartedAt,
  isRpcSourceActive,
  setRpcSourceProjectSessionActive,
  type RpcSourceRef,
  type RpcSourceAdapter,
} from "../sessions/session-controller.rpc-sources.js";
import { markReplyOperationExecutionStarted } from "../sessions/session-controller.state.js";
import { testing as controllerTesting } from "../sessions/session-controller.test-support.js";
import { rpcSourceTesting } from "../sessions/session-lifecycle-admission.test-support.js";
import {
  abortChatRunById,
  abortChatRunsForProvider,
  registerChatAbortController,
  resolveAgentRunExpiresAtMs,
  resolveChatRunExpiresAtMs,
  type ChatAbortOps,
  updateChatRunProvider,
} from "./chat-abort.js";
import type { ChatCanvasBlock } from "./chat-display-projection.canvas.js";
import { createChatRunState } from "./server-chat-state.js";

type CreatedChatAbortOps = ChatAbortOps & {
  broadcast: ReturnType<typeof vi.fn>;
  nodeSendToSession: ReturnType<typeof vi.fn>;
  removeChatRun: ReturnType<typeof vi.fn>;
};

const createdSources = new Set<RpcSourceRef>();
afterEach(async () => {
  for (const source of createdSources) {
    source.input.claim?.operation?.complete();
    if (source.input.claim) {
      releaseSessionControllerClaim(source.input.claim);
    }
  }
  await Promise.all(
    [...createdSources].map((source) => source.input.settlement.promise.catch(() => {})),
  );
  createdSources.clear();
  controllerTesting.resetSessionControllerForTest();
  vi.useRealTimers();
});

async function createActiveEntry(
  sessionKey: string,
  metadata: Partial<RpcSourceAdapter> = {},
  identity: { sessionId?: string; agentId?: string } = {},
  claimOperation = true,
): Promise<RpcSourceRef> {
  const sessionId = identity.sessionId ?? "sess-1";
  const adapter: RpcSourceAdapter = { ...metadata };
  const target = captureSessionTarget({
    storeScope: "/synthetic/chat-abort/" + randomUUID(),
    sessionKey,
    incarnation: sessionId,
    agentId: identity.agentId,
  });
  const input = reserveSessionControllerSource(sessionKey, {
    target,
    adapter,
    sourceSessionId: sessionId,
    policy: { mode: "followup" },
  });
  if (claimOperation) {
    await claimSessionControllerTask(input, (claim) => {
      const operation = createReplyOperation({
        sessionKey,
        sessionId,
        agentId: identity.agentId,
        resetTriggered: false,
        target,
        mailboxClaim: claim,
      });
      markReplyOperationExecutionStarted(operation);
      operation.setPhase("running");
    });
  }
  const ref = { input, adapter };
  createdSources.add(ref);
  return ref;
}

function createOps(params: {
  runId: string;
  entry: RpcSourceRef;
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

  rpcSourceTesting.reset([[runId, entry]]);
  return {
    chatRunState,
    removeChatRun,
    agentRunSeq: new Map(),
    broadcast,
    nodeSendToSession,
  };
}

async function createAbortRunFixture(params: {
  runId?: string;
  sessionKey?: string;
  entry?: RpcSourceRef;
  buffer?: string;
  now?: Date;
}): Promise<{
  runId: string;
  sessionKey: string;
  entry: RpcSourceRef;
  ops: CreatedChatAbortOps;
}> {
  const runId = params.runId ?? "run-1";
  const sessionKey = params.sessionKey ?? "main";
  if (params.now) {
    vi.useFakeTimers();
    vi.setSystemTime(params.now);
  }
  const entry = params.entry ?? (await createActiveEntry(sessionKey));
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
  entry: RpcSourceRef;
  ops: ChatAbortOps;
  runId: string;
}): void {
  expect(params.result).toEqual({ aborted: true });
  expect(params.entry.input.abortSignal.aborted).toBe(true);
  // Cancellation is not producer settlement; the exact claim still protects retries.
  expect(rpcSourceTesting.get(params.runId)).toBe(params.entry);
  expect(isRpcSourceActive(params.entry)).toBe(false);
}

it.each([
  { waiting: true, claimed: true },
  { waiting: false, claimed: true },
  { waiting: true, claimed: false },
  { waiting: false, claimed: false },
])(
  "captures the live local wait before abort listeners clear it: %j",
  async ({ waiting, claimed }) => {
    const raw = await createActiveEntry("main", {}, {}, claimed);
    const { runId, sessionKey, entry, ops } = await createAbortRunFixture({ entry: raw });
    if (claimed) {
      expectDefined(entry.input.claim?.operation, "operation").attachBackend({
        kind: "embedded",
        runId,
        cancel: () => {},
      });
    }
    const context = waiting ? { localModelWait: { requestId: "call-1" } } : {};
    registerAgentRunContext(runId, {});
    Object.assign(expectDefined(getAgentRunContext(runId), "registered run"), context);
    entry.input.abortSignal.addEventListener("abort", () => {
      clearAgentRunContext(runId);
    });
    try {
      const result = abortChatRunById(ops, { runId, sessionKey });
      if (claimed) {
        expectRunAborted({ result, entry, ops, runId });
      } else {
        expect(result).toEqual({ aborted: true });
        expect(entry.input.abortSignal.aborted).toBe(true);
        // No producer or pending source work remains to retain this registration.
        expect(rpcSourceTesting.has(runId)).toBe(false);
        expect(entry.input.phase).toBe("consumed");
        await expect(entry.input.settlement.promise).resolves.toBeUndefined();
      }
      expect(isAgentRunDirectAbortReason(entry.input.abortSignal.reason)).toBe(true);
      expect(firstBroadcastPayload(ops)).toMatchObject({ state: "aborted" });
      expect(Value.Check(ChatEventSchema, firstBroadcastPayload(ops))).toBe(true);
      if (waiting) {
        expect(firstBroadcastPayload(ops)).toHaveProperty("localModelMayStillBeFinishing", true);
      } else {
        expect(firstBroadcastPayload(ops)).not.toHaveProperty("localModelMayStillBeFinishing");
      }
    } finally {
      clearAgentRunContext(runId);
    }
  },
);

describe("registerChatAbortController", () => {
  it("bounds default and agent run expiry calculations to valid Date timestamps", async () => {
    expect(resolveChatRunExpiresAtMs({ now: Number.NaN, timeoutMs: 60_000 })).toBe(0);
    expect(resolveChatRunExpiresAtMs({ now: 8_640_000_000_000_000, timeoutMs: 60_000 })).toBe(0);
    expect(resolveAgentRunExpiresAtMs({ now: Number.NaN, timeoutMs: 60_000 })).toBe(0);
  });

  it("records hidden/internal visibility for agent registrations", async () => {
    rpcSourceTesting.clear();
    const registration = registerChatAbortController({
      target: captureSessionTarget({
        storeScope: "/synthetic/chat-registration",
        sessionKey: "main",
        incarnation: "sess-1",
      }),
      runId: "run-internal-agent",
      sessionId: "sess-1",
      sessionKey: "main",
      timeoutMs: 60_000,
      controlUiVisible: false,
      kind: "agent",
    });

    expect(registration.entry?.adapter).toMatchObject({
      controlUiVisible: false,
      kind: "agent",
    });
    expect(rpcSourceTesting.get("run-internal-agent")?.adapter.controlUiVisible).toBe(false);
  });

  it("adopts a reserved source without allocating a second mailbox sequence", async () => {
    rpcSourceTesting.clear();
    const target = captureSessionTarget({
      storeScope: "/synthetic/adopted-chat-registration",
      sessionKey: "main",
      incarnation: "sess-adopted",
    });
    const input = reserveSessionControllerSource("main", {
      target,
      reservationId: "subagent-completion:run-adopted:0",
      policy: { mode: "followup" },
    });
    const sequence = input.sequence;
    const registration = registerChatAbortController({
      target,
      sourceInput: input,
      runId: "run-adopted",
      sessionId: "sess-adopted",
      sessionKey: "main",
      timeoutMs: 60_000,
    });

    expect(registration.entry?.input).toBe(input);
    expect(input.sequence).toBe(sequence);
    expect(input.mailbox.entries).toEqual([input]);
    expect(input.custody.rpcAdopted).toBe(true);
    registration.cleanup();
    await input.settlement.promise;
  });

  it("keeps preparing sources cancellable without starting an execution timeout", async () => {
    vi.useFakeTimers();
    rpcSourceTesting.clear();
    const registration = registerChatAbortController({
      target: captureSessionTarget({
        storeScope: "/synthetic/preparing",
        sessionKey: "main",
        incarnation: "sess-1",
      }),
      runId: "preparing",
      sessionKey: "main",
      sessionId: "sess-1",
      timeoutMs: 1,
    });
    if (!registration.entry) {
      throw new Error("Expected reserved source");
    }
    expect(isRpcSourceActive(registration.entry)).toBe(false);
    expect(getRpcSourceStartedAt(registration.entry)).toBeUndefined();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(registration.entry.input.abortSignal.aborted).toBe(false);
    expect(registration.markExecutionStarted()).toBe(false);
    registration.controller.abort();
    expect(registration.entry.input.abortSignal.aborted).toBe(true);
    registration.cleanup();
  });

  it("retains completed registrations until terminal persistence succeeds", async () => {
    rpcSourceTesting.clear();
    const onRemoved = vi.fn();
    const registration = registerChatAbortController({
      target: captureSessionTarget({
        storeScope: "/synthetic/chat-registration",
        sessionKey: "main",
        incarnation: "sess-1",
      }),
      runId: "run-persisting",
      sessionId: "sess-1",
      sessionKey: "main",
      timeoutMs: 60_000,
      onRemoved,
    });
    let resolvePersistence: () => void = () => undefined;
    const persistence = new Promise<void>((resolve) => {
      resolvePersistence = resolve;
    });
    if (!registration.entry) {
      throw new Error("expected registered entry");
    }
    setRpcSourceProjectSessionActive(registration.entry, false);
    registration.entry.adapter.projectSessionTerminalPersistence = persistence;

    registration.cleanup();

    expect(rpcSourceTesting.has("run-persisting")).toBe(true);
    expect(onRemoved).not.toHaveBeenCalled();
    resolvePersistence();
    await registration.entry.input.settlement.promise;
    expect(rpcSourceTesting.has("run-persisting")).toBe(false);
    expect(onRemoved).toHaveBeenCalledTimes(1);
  });

  it("retains registrations when terminal lifecycle was observed before caller cleanup", async () => {
    rpcSourceTesting.clear();
    const registration = registerChatAbortController({
      target: captureSessionTarget({
        storeScope: "/synthetic/chat-registration",
        sessionKey: "main",
        incarnation: "sess-1",
      }),
      runId: "run-awaiting-terminal",
      sessionId: "sess-1",
      sessionKey: "main",
      timeoutMs: 60_000,
    });

    if (!registration.entry) {
      throw new Error("expected registered entry");
    }
    registration.entry.adapter.projectSessionTerminalPending = true;
    registration.cleanup();

    expect(rpcSourceTesting.has("run-awaiting-terminal")).toBe(true);
    expect(registration.entry.input.retirementRequested).toBe(true);
  });

  it("cleans registrations when dispatch fails before lifecycle starts", async () => {
    rpcSourceTesting.clear();
    const registration = registerChatAbortController({
      target: captureSessionTarget({
        storeScope: "/synthetic/chat-registration",
        sessionKey: "main",
        incarnation: "sess-1",
      }),
      runId: "run-before-dispatch",
      sessionId: "sess-1",
      sessionKey: "main",
      timeoutMs: 60_000,
    });

    registration.cleanup();
    await registration.entry?.input.settlement.promise;
    expect(rpcSourceTesting.has("run-before-dispatch")).toBe(false);
  });
});

describe("abortChatRunById", () => {
  it("notifies the run-bound approval owner only after an active run abort wins", async () => {
    const { runId, sessionKey, ops } = await createAbortRunFixture({});
    const onRunAborted = vi.fn();
    ops.onRunAborted = onRunAborted;

    expect(abortChatRunById(ops, { runId: "other-run", sessionKey })).toEqual({
      aborted: false,
    });
    expect(onRunAborted).not.toHaveBeenCalled();

    expect(abortChatRunById(ops, { runId, sessionKey, stopReason: "user" })).toEqual({
      aborted: true,
    });
    expect(onRunAborted).toHaveBeenCalledOnce();
    expect(onRunAborted).toHaveBeenCalledWith(runId);
  });

  it.each(["declined", "authority-revoked"] as const)(
    "allows the real terminal publication after an uncommitted %s Stop",
    async (outcome) => {
      const { runId, sessionKey, entry, ops } = await createAbortRunFixture({
        runId: `run-uncommitted-${outcome}`,
      });
      const sessionId = getRpcSourceIdentity(entry).sessionId;
      registerAgentRunContext(runId, { sessionKey, sessionId });
      const terminal = vi.fn();
      const unsubscribe = onAgentRuntimeEvent((event) => {
        if (
          event.runId === runId &&
          event.stream === "lifecycle" &&
          (event.admitLifecyclePublication?.() ?? true)
        ) {
          terminal(event.data);
        }
      });
      const failure = new Error("authority changed");
      const cancel = () => {
        if (outcome === "authority-revoked") {
          throw failure;
        }
        return false;
      };
      try {
        if (outcome === "authority-revoked") {
          expect(() => abortChatRunById(ops, { runId, sessionKey, cancel })).toThrow(failure);
        } else {
          expect(abortChatRunById(ops, { runId, sessionKey, cancel })).toEqual({ aborted: false });
        }
        expect(entry.input.abortSignal.aborted).toBe(false);
        expect(terminal).not.toHaveBeenCalled();
        emitAgentEvent({
          runId,
          sessionKey,
          sessionId,
          stream: "lifecycle",
          data: { phase: "end", status: "success" },
        });
        expect(terminal).toHaveBeenCalledExactlyOnceWith({ phase: "end", status: "success" });
      } finally {
        unsubscribe();
        clearAgentRunContext(runId);
      }
    },
  );

  it("retains terminal persistence ownership observed during abort", async () => {
    const { runId, sessionKey, entry, ops } = await createAbortRunFixture({});
    let terminalEvents = 0;
    const unsubscribe = onAgentEvent((event) => {
      if (event.runId === runId && event.stream === "lifecycle" && event.data.phase === "end") {
        terminalEvents += 1;
        entry.adapter.projectSessionTerminalPending = true;
        entry.adapter.projectSessionTerminalObservedAt = event.ts;
      }
    });

    try {
      const result = abortChatRunById(ops, { runId, sessionKey, stopReason: "user" });

      expect(result).toEqual({ aborted: true });
      expect(entry.input.abortSignal.aborted).toBe(true);
      expect(getRpcSourceProjectSessionActive(entry)).toBe(false);
      expect(entry.input.retirementRequested).toBe(true);
      expect(entry.adapter.projectSessionTerminalPending).toBe(true);
      expect(entry.adapter.projectSessionTerminalObservedAt).toEqual(expect.any(Number));
      expect(rpcSourceTesting.get(runId)).toBe(entry);
      entry.input.claim?.operation?.complete();
      expect(getRpcSourceProjectSessionActive(entry)).toBe(false);

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

  it("preserves the owning session identity when synchronous abort cleanup clears run context", async () => {
    const { runId, sessionKey, entry, ops } = await createAbortRunFixture({
      runId: "run-pre-reset-abort",
    });
    const sessionId = getRpcSourceIdentity(entry).sessionId;
    registerAgentRunContext(runId, { sessionKey, sessionId });
    entry.input.abortSignal.addEventListener("abort", () => clearAgentRunContext(runId));
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
      expect(events).toEqual([{ sessionId }]);
    } finally {
      unsubscribe();
      clearAgentRunContext(runId);
    }
  });

  it("broadcasts aborted payload with partial message when buffered text exists", async () => {
    const now = new Date("2026-01-02T03:04:05.000Z");
    const { runId, sessionKey, entry, ops } = await createAbortRunFixture({
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

  it("omits aborted message when buffered text is empty", async () => {
    const { runId, sessionKey, ops } = await createAbortRunFixture({ buffer: "   " });

    const result = abortChatRunById(ops, { runId, sessionKey });

    expect(result).toEqual({ aborted: true });
    const payload = firstBroadcastPayload(ops) as Record<string, unknown>;
    expect(payload.message).toBeUndefined();
  });

  it("includes the active run's safe validation diagnostic", async () => {
    const runId = "run-validation-abort";
    const sessionKey = "main";
    const entry = await createActiveEntry(sessionKey, {
      toolErrorSummary: "edit tool validation failed: edits: must be an array",
    });
    const ops = createOps({ runId, entry });

    abortChatRunById(ops, { runId, sessionKey, stopReason: "user" });

    expect(firstBroadcastPayload(ops)).toMatchObject({
      runId,
      state: "aborted",
      errorMessage: "edit tool validation failed: edits: must be an array",
    });
  });

  it("preserves finalizing runs when the owning reply operation rejects aborts", async () => {
    const finalizingEntry = await createActiveEntry("main");
    finalizingEntry.input.claim?.operation?.freezeAbort();
    const { runId, sessionKey, entry, ops } = await createAbortRunFixture({
      buffer: "completed reply",
      entry: finalizingEntry,
    });

    const result = abortChatRunById(ops, { runId, sessionKey, stopReason: "user" });

    expect(result).toEqual({ aborted: false });
    expect(entry.input.abortSignal.aborted).toBe(false);
    expect(rpcSourceTesting.get(runId)).toBe(entry);
    expect(ops.chatRunState.runs.get(runId)?.buffer).toBe("completed reply");
    expect(ops.chatRunState.runs.get(runId)?.abortMarker).toBeUndefined();
    expect(ops.removeChatRun).not.toHaveBeenCalled();
    expect(ops.broadcast).not.toHaveBeenCalled();
    expect(ops.nodeSendToSession).not.toHaveBeenCalled();
  });

  it("aborts hidden internal runs without broadcasting chat events", async () => {
    const sessionKey = "main";
    const { runId, entry, ops } = await createAbortRunFixture({
      runId: "run-hidden",
      sessionKey,
      entry: await createActiveEntry(sessionKey, { controlUiVisible: false }),
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
      createEntry: () => createActiveEntry("global", {}, { agentId: "main" }),
      abort: abortChatRunById,
    },
    {
      name: "resolves unscoped global aborts to the default agent subscribers",
      runId: "run-unscoped-global",
      createEntry: () => createActiveEntry("global"),
      abort: abortChatRunById,
    },
  ]) {
    it(testCase.name, async () => {
      const ops = createOps({ runId: testCase.runId, entry: await testCase.createEntry() });
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

  it.each([
    { stopReason: undefined, kind: "direct" },
    { stopReason: "rpc", kind: "direct" },
    { stopReason: "timeout", kind: "timeout" },
    { stopReason: "restart", kind: "restart" },
  ] as const)(
    "tags $stopReason abort signals with $kind cancellation evidence",
    async ({ stopReason, kind }) => {
      const { runId, sessionKey, entry, ops } = await createAbortRunFixture({});

      const result = abortChatRunById(ops, { runId, sessionKey, stopReason });

      expect(result).toEqual({ aborted: true });
      expect(entry.adapter.abortStopReason).toBe(stopReason);
      const signal = entry.input.abortSignal;
      expect(signal.aborted).toBe(true);
      expect(signal.reason).toMatchObject({
        name: kind === "timeout" ? "TimeoutError" : "AbortError",
      });
      expect(isAgentRunDirectAbortReason(signal.reason)).toBe(kind === "direct");
      expect(isAgentRunRestartAbortReason(signal.reason)).toBe(kind === "restart");
    },
  );

  it.each([
    ["streamed text", true, true],
    ["", true, true],
    ["NO_REPLY", true, true],
    ["stale text", false, false],
  ] as const)(
    "snapshots completed widgets before synchronous abort cleanup (%j, current=%j)",
    async (buffer, current, visible) => {
      let ownsBuffer = current;
      const now = new Date("2026-01-02T03:04:05.000Z");
      const { runId, sessionKey, entry, ops } = await createAbortRunFixture({
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

      entry.input.abortSignal.addEventListener("abort", () => {
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
  it("uses updated provider metadata after model fallback", async () => {
    const runId = "run-1";
    const sessionKey = "main";
    const entry = await createActiveEntry(sessionKey);
    entry.adapter.providerId = "openai";
    entry.adapter.authProviderId = "openai";
    const ops = createOps({ runId, entry });

    const updated = updateChatRunProvider({
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
    expect(entry.input.abortSignal.aborted).toBe(true);
    expect(isAgentRunDirectAbortReason(entry.input.abortSignal.reason)).toBe(true);
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

  it("derives missing entry agent ids from canonical session keys", async () => {
    const writerEntry = await createActiveEntry("agent:writer:main");
    writerEntry.adapter.providerId = "openrouter";
    const mainEntry = await createActiveEntry("agent:main:main");
    mainEntry.adapter.providerId = "openrouter";
    const ops = createOps({ runId: "run-writer", entry: writerEntry });
    rpcSourceTesting.set("run-main", mainEntry);

    const result = abortChatRunsForProvider(ops, {
      cfg: { agents: { entries: { main: {}, writer: {} } } },
      providerId: "openrouter",
      agentId: "writer",
      stopReason: "auth-revoked",
    });

    expect(result.runIds).toEqual(["run-writer"]);
    expect(writerEntry.input.abortSignal.aborted).toBe(true);
    expect(mainEntry.input.abortSignal.aborted).toBe(false);
  });
});
