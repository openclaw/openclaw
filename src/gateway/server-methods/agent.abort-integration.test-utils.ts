// Imported by agent.test.ts to keep its mocked suite in one Vitest module graph.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { isAgentRunDirectAbortReason } from "../../agents/run-termination.js";
import { runSessionMutation } from "../../sessions/session-controller.lifecycle.js";
import {
  getRpcSourceIdentity,
  getRpcSourceExpiresAt,
  getRpcSourceProjectSessionActive,
  type RpcSourceRef,
} from "../../sessions/session-controller.rpc-sources.js";
import { rpcSourceTesting } from "../../sessions/session-lifecycle-admission.test-support.js";
import * as agentHandlerHelpers from "../agent-turn/agent-handler-helpers.js";
import { setGatewayDedupeEntry } from "../agent-turn/agent-job.js";
import { prepareAgentRunDispatch } from "../agent-turn/agent-run-admission-phase.js";
import { createAgentTurnIo } from "../agent-turn/io.js";
import { resolveAgentRunExpiresAtMs } from "../chat-abort.js";
import { createRpcSourceForTest } from "../test-helpers.rpc-source.js";
import {
  registerAgentAbortRunExecutionTest,
  registerAgentAbortStaleKeyExecutionTest,
} from "./agent.abort-execution.test-support.js";
import { registerAgentAbortQueueDeadlineTest } from "./agent.abort-queue-deadline.test-support.js";
import { registerAgentAbortSubagentTests } from "./agent.abort-subagents.test-utils.js";
import { registerAgentPreDispatchFailureTests } from "./agent.pre-dispatch-failure.test-utils.js";
import { registerAgentGlobalGoalEventTest } from "./agent.session-events.test-utils.js";
import {
  createElevatedExecApprovalFixture,
  mockTelegramSessionEntry,
  getAgentTestMocks,
  operatorWriteCliClient,
  makeContext,
  waitForAssertion,
  requireValue,
  expectRecordFields,
  mockCallArg,
  expectRespondError,
  flushScheduledDispatchStep,
  buildExistingMainStoreEntry,
  backendGatewayClient,
  mockMainSessionEntry,
  invokeAgent,
  describe1BeforeEach0,
  describe1AfterEach1,
  prime,
} from "./agent.test-harness.js";
import { getAgentTestStorePath } from "./agent.user-turn-recorder.test-support.js";
import { handleChatAbortRequest } from "./chat-abort-handler.js";
import { handleDirectExternalChatSend } from "./chat-send-external-entry.js";
import type { GatewayRequestContext } from "./types.js";

const mocks = getAgentTestMocks();

type HeldAgentResult = {
  payloads: Array<{ text: string }>;
  meta: { durationMs: number };
};

function holdFirstMainSessionWrite() {
  let releaseSessionWrite: (() => void) | undefined;
  let sessionWriteCalls = 0;
  mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
    sessionWriteCalls += 1;
    if (sessionWriteCalls === 1) {
      await new Promise<void>((resolve) => {
        releaseSessionWrite = resolve;
      });
    }
    const store = {
      "agent:main:main": buildExistingMainStoreEntry(),
    };
    return await updater(store);
  });
  return {
    get calls() {
      return sessionWriteCalls;
    },
    release: () => releaseSessionWrite?.(),
  };
}

function createHeldVisionCatalog() {
  let releaseCatalog: (() => void) | undefined;
  const context = {
    ...makeContext(),
    loadGatewayModelCatalog: vi.fn<GatewayRequestContext["loadGatewayModelCatalog"]>(
      async () =>
        await new Promise<Awaited<ReturnType<GatewayRequestContext["loadGatewayModelCatalog"]>>>(
          (resolve) => {
            releaseCatalog = () =>
              resolve([
                {
                  id: "vision-model",
                  name: "vision-model",
                  provider: "test",
                  input: ["image"],
                },
              ]);
          },
        ),
    ),
  };
  return { context, releaseCatalog: () => releaseCatalog?.() };
}

function pixelAttachments() {
  return [
    {
      type: "file",
      mimeType: "image/png",
      fileName: "pixel.png",
      content: Buffer.from("not really a png").toString("base64"),
    },
  ];
}

function captureAgentRunSettlement(runId: string): Promise<void> {
  const source = rpcSourceTesting.get(runId);
  return Promise.all([
    source?.input.settlement.promise,
    source?.input.claim?.operation?.ownerSettlement,
  ]).then(() => {
    if (source) {
      expect(rpcSourceTesting.get(runId)).not.toBe(source);
    }
  });
}

function expectPreparingAgentSource(
  runId: string,
  identity: { sessionKey: string; sessionId: string; agentId: string },
): RpcSourceRef {
  const source = requireValue(rpcSourceTesting.get(runId), "preparing agent source missing");
  expect(getRpcSourceIdentity(source)).toEqual(identity);
  expect(source.input.target?.storeScope).toBe(getAgentTestStorePath());
  expect(source.input.phase).toBe("preparing");
  expect(source.input.claim).toBeUndefined();
  expect(source.input.abortSignal.aborted).toBe(false);
  expect(mocks.agentCommand).not.toHaveBeenCalled();
  return source;
}

function expectMainAlias(payload: unknown, runId: string, alias: string): void {
  expectRecordFields(payload, {
    runId,
    status: "accepted",
    sessionKey: "agent:main:main",
    sessionId: "existing-session-id",
    sessionKeyAliases: [alias],
  });
}

function sourceQueuedAt(source: RpcSourceRef): number {
  return requireValue(source.adapter.timing, "source timing missing").queuedAtMs;
}

function sourceExpiry(source: RpcSourceRef): number {
  return requireValue(getRpcSourceExpiresAt(source), "source deadline missing");
}

describe("gateway agent handler chat.abort integration", () => {
  beforeEach(describe1BeforeEach0);

  afterEach(describe1AfterEach1);

  it("registers an abort controller into rpcSourceTesting for an agent run", async () => {
    prime();
    const agentResult = createDeferred<HeldAgentResult>();
    mocks.agentCommand.mockReturnValueOnce(agentResult.promise);

    const context = makeContext();
    const runId = "idem-abort-register";
    try {
      await invokeAgent(
        {
          message: "hi",
          agentId: "main",
          sessionKey: "agent:main:main",
          idempotencyKey: runId,
        },
        {
          context,
          reqId: runId,
          client: { ...operatorWriteCliClient(), connId: "conn-1" },
        },
      );

      const entry = rpcSourceTesting.get(runId);
      const abortEntry = requireValue(entry, "chat abort entry missing");
      const identity = getRpcSourceIdentity(abortEntry);
      expect(identity.sessionKey).toBe("agent:main:main");
      expect(identity.sessionId).toBe("existing-session-id");
      expect(abortEntry.adapter.requester?.connectionId).toBe("conn-1");
      expect(abortEntry.input.abortSignal.aborted).toBe(false);
      expect(sourceExpiry(abortEntry) - sourceQueuedAt(abortEntry)).toBeGreaterThan(
        24 * 60 * 60_000,
      );
    } finally {
      const settlement = captureAgentRunSettlement(runId);
      agentResult.resolve({ payloads: [], meta: { durationMs: 1 } });
      await settlement;
    }
  });

  registerAgentGlobalGoalEventTest();

  it("yields after the accepted ack before dispatching heavy agent work", async () => {
    prime();
    mocks.agentCommand.mockResolvedValueOnce({
      payloads: [{ text: "ok" }],
      meta: { durationMs: 100 },
    });

    const context = makeContext();
    const respond = vi.fn();
    const runId = "idem-yield-before-dispatch";
    const pending = invokeAgent(
      {
        message: "hi",
        agentId: "main",
        sessionKey: "agent:main:main",
        idempotencyKey: runId,
      },
      { context, respond, reqId: runId, flushDispatch: false },
    );
    await pending;

    expect(mockCallArg(respond)).toBe(true);
    const acceptedPayload = expectRecordFields(mockCallArg(respond, 0, 1), {
      runId,
      status: "accepted",
    });
    expect(acceptedPayload).not.toHaveProperty("dedupeKeys");
    expect(acceptedPayload).not.toHaveProperty("ownerConnId");
    expect(acceptedPayload).not.toHaveProperty("ownerDeviceId");
    expectRecordFields(context.dedupe.get(`agent:${runId}`)?.payload, {
      runId,
      status: "accepted",
      dedupeKeys: [`agent:${runId}`],
    });
    expect(mockCallArg(respond, 0, 2)).toBeUndefined();
    expect(mockCallArg(respond, 0, 3)).toEqual({ runId });
    expect(mocks.agentCommand).not.toHaveBeenCalled();

    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(mocks.agentCommand).not.toHaveBeenCalled();
    await waitForAssertion(() => expect(mocks.agentCommand).toHaveBeenCalledTimes(1));

    expect(mocks.agentCommand).toHaveBeenCalledTimes(1);
  });

  it("does not dispatch when chat.abort lands during the accepted ack yield", async () => {
    prime();
    mocks.agentCommand.mockResolvedValueOnce({
      payloads: [{ text: "ok" }],
      meta: { durationMs: 100 },
    });

    const context = makeContext();
    const respond = vi.fn();
    const runId = "idem-abort-before-dispatch";
    const pending = invokeAgent(
      {
        message: "hi",
        agentId: "main",
        sessionKey: "agent:main:main",
        idempotencyKey: runId,
      },
      { context, respond, reqId: runId, flushDispatch: false },
    );
    await pending;
    expect(respond).toHaveBeenCalled();
    expect(mocks.agentCommand).not.toHaveBeenCalled();

    expectRecordFields(mockCallArg(respond, 0, 1), {
      runId,
      sessionKey: "agent:main:main",
      status: "accepted",
    });
    const active = requireValue(rpcSourceTesting.get(runId), "active run missing");

    const abortRespond = vi.fn();
    await handleChatAbortRequest({
      params: { sessionKey: "agent:main:main", runId },
      respond: abortRespond as never,
      context,
      req: { type: "req", id: "abort-req", method: "chat.abort" },
      client: null,
      isWebchatConnect: () => false,
    });

    expectRecordFields(mockCallArg(abortRespond, 0, 1), {
      aborted: true,
      runIds: [runId],
    });
    expect(active.input.abortSignal.aborted).toBe(true);
    expect(getRpcSourceProjectSessionActive(active)).toBe(false);
    await active.input.settlement.promise;
    expect(rpcSourceTesting.has(runId)).toBe(false);
    await pending;

    await flushScheduledDispatchStep();

    expect(mocks.agentCommand).not.toHaveBeenCalled();
    expectRecordFields(context.dedupe.get(`agent:${runId}`)?.payload, {
      runId,
      status: "timeout",
      summary: "aborted",
      stopReason: "rpc",
      timeoutPhase: "queue",
      providerStarted: false,
    });
    const finalResponse = respond.mock.calls.find(
      (call: unknown[]) => (call[1] as { status?: unknown } | undefined)?.status === "timeout",
    );
    expectRecordFields(requireValue(finalResponse, "terminal response missing")[1], {
      runId,
      status: "timeout",
      stopReason: "rpc",
      timeoutPhase: "queue",
      providerStarted: false,
    });
  });

  it("preserves stop-command reason when /stop lands during the accepted ack yield", async () => {
    prime();
    // Keep the ACK yield pending while Stop reads durable retry state.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    mocks.agentCommand.mockResolvedValueOnce({
      payloads: [{ text: "unexpected dispatch" }],
      meta: { durationMs: 1 },
    });

    const context = makeContext();
    const respond = vi.fn();
    const runId = "idem-stop-before-dispatch";
    await invokeAgent(
      {
        message: "hi",
        agentId: "main",
        sessionKey: "agent:main:main",
        idempotencyKey: runId,
      },
      { context, respond, reqId: runId, flushDispatch: false },
    );

    expectRecordFields(mockCallArg(respond, 0, 1), {
      runId,
      sessionKey: "agent:main:main",
      status: "accepted",
    });
    const active = requireValue(rpcSourceTesting.get(runId), "active run missing");

    const stopRespond = vi.fn();
    await handleDirectExternalChatSend({
      params: {
        sessionKey: "agent:main:main",
        message: "/stop",
        idempotencyKey: "idem-stop-command-before-dispatch",
      },
      respond: stopRespond as never,
      context,
      req: { type: "req", id: "stop-req", method: "chat.send" },
      client: null,
      isWebchatConnect: () => false,
    });
    await flushScheduledDispatchStep();

    expectRecordFields(mockCallArg(stopRespond, 0, 1), {
      aborted: true,
      runIds: [runId],
    });
    expect(active.input.abortSignal.aborted).toBe(true);
    expect(getRpcSourceProjectSessionActive(active)).toBe(false);
    await active.input.settlement.promise;
    expect(rpcSourceTesting.has(runId)).toBe(false);

    expect(mocks.agentCommand).not.toHaveBeenCalled();
    expectRecordFields(context.dedupe.get(`agent:${runId}`)?.payload, {
      runId,
      status: "timeout",
      summary: "aborted",
      stopReason: "stop",
    });
    const finalResponse = respond.mock.calls.find(
      (call: unknown[]) => (call[1] as { status?: unknown } | undefined)?.status === "timeout",
    );
    expectRecordFields(requireValue(finalResponse, "terminal response missing")[1], {
      runId,
      status: "timeout",
      stopReason: "stop",
    });
  });

  it("does not dispatch when chat.abort lands during pre-accept setup", async () => {
    prime();
    const requestedSessionKey = "agent:main:legacy-main";
    const sessionWrite = holdFirstMainSessionWrite();
    const agentResult = createDeferred<HeldAgentResult>();
    mocks.agentCommand.mockReturnValueOnce(agentResult.promise);

    const context = makeContext();
    const respond = vi.fn();
    const ownerClient = { ...operatorWriteCliClient(), connId: "preaccept-owner" };
    const runId = "idem-abort-before-registration";
    const pending = invokeAgent(
      {
        message: "hi",
        agentId: "main",
        sessionKey: requestedSessionKey,
        idempotencyKey: runId,
      },
      { context, respond, client: ownerClient, reqId: runId, flushDispatch: false },
    );
    let cancellation: Promise<void> | undefined;
    try {
      await waitForAssertion(() => expect(sessionWrite.calls).toBe(1));
      const source = expectPreparingAgentSource(runId, {
        sessionKey: "agent:main:main",
        sessionId: "existing-session-id",
        agentId: "main",
      });
      expectMainAlias(context.dedupe.get(`agent:${runId}`)?.payload, runId, requestedSessionKey);

      const abortRespond = vi.fn();
      cancellation = handleChatAbortRequest({
        params: { sessionKey: requestedSessionKey, runId },
        respond: abortRespond as never,
        context,
        req: { type: "req", id: "abort-req", method: "chat.abort" },
        client: ownerClient,
        isWebchatConnect: () => false,
      });
      await cancellation;
      expect(source.input.abortSignal.aborted).toBe(true);
      expect(rpcSourceTesting.get(runId)).toBe(source);
      expect(mockCallArg(abortRespond)).toBe(true);
      expectRecordFields(mockCallArg(abortRespond, 0, 1), {
        aborted: true,
        runIds: [runId],
      });

      expectRecordFields(context.dedupe.get(`agent:${runId}`)?.payload, {
        runId,
        sessionKey: requestedSessionKey,
        status: "timeout",
        summary: "aborted",
        stopReason: "rpc",
      });

      sessionWrite.release();
      await pending;
      await flushScheduledDispatchStep();

      expect(mocks.agentCommand).not.toHaveBeenCalled();
      expect(rpcSourceTesting.has(runId)).toBe(false);
      const finalResponse = respond.mock.calls.find(
        (call: unknown[]) => (call[1] as { status?: unknown } | undefined)?.status === "timeout",
      );
      expectRecordFields(requireValue(finalResponse, "terminal response missing")[1], {
        runId,
        status: "timeout",
        stopReason: "rpc",
        timeoutPhase: "queue",
        providerStarted: false,
      });
    } finally {
      const settlement = captureAgentRunSettlement(runId);
      agentResult.resolve({ payloads: [], meta: { durationMs: 1 } });
      sessionWrite.release();
      await Promise.allSettled([pending, cancellation]);
      await flushScheduledDispatchStep();
      await settlement;
      await captureAgentRunSettlement(runId);
    }
  });

  it("keeps selected-global alias scope when aborting during pre-accept setup", async () => {
    mocks.listAgentIds.mockReturnValue(["main", "work"]);
    mocks.loadConfigReturn = {
      agents: { entries: { main: {}, work: {} } },
      session: { scope: "global" },
    };
    mocks.loadSessionEntry.mockReturnValue({
      cfg: mocks.loadConfigReturn,
      storePath: getAgentTestStorePath(),
      entry: {
        sessionId: "global-work-session-id",
        updatedAt: Date.now(),
      },
      canonicalKey: "global",
    });
    const requestedSessionKey = "agent:work:main";
    let releaseSessionWrite: (() => void) | undefined;
    let sessionWriteCalls = 0;
    mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
      sessionWriteCalls += 1;
      if (sessionWriteCalls === 1) {
        await new Promise<void>((resolve) => {
          releaseSessionWrite = resolve;
        });
      }
      const store = {
        global: {
          sessionId: "global-work-session-id",
          updatedAt: Date.now(),
        },
      };
      return await updater(store);
    });
    const agentResult = createDeferred<HeldAgentResult>();
    mocks.agentCommand.mockReturnValueOnce(agentResult.promise);

    const context = makeContext();
    const respond = vi.fn();
    const runId = "idem-selected-global-alias-abort-before-registration";
    const pending = invokeAgent(
      {
        message: "hi",
        agentId: "work",
        sessionKey: requestedSessionKey,
        idempotencyKey: runId,
      },
      { context, respond, reqId: runId, flushDispatch: false },
    );
    let cancellation: Promise<void> | undefined;
    try {
      await waitForAssertion(() => expect(sessionWriteCalls).toBe(1));
      const source = expectPreparingAgentSource(runId, {
        sessionKey: "global",
        sessionId: "global-work-session-id",
        agentId: "work",
      });
      expectRecordFields(context.dedupe.get(`agent:${runId}`)?.payload, {
        runId,
        sessionKey: "global",
        agentId: "work",
        status: "accepted",
      });

      const abortRespond = vi.fn();
      cancellation = handleChatAbortRequest({
        params: { sessionKey: "global", agentId: "work", runId },
        respond: abortRespond as never,
        context,
        req: { type: "req", id: "abort-selected-global-alias-req", method: "chat.abort" },
        client: null,
        isWebchatConnect: () => false,
      });
      await cancellation;
      expect(source.input.abortSignal.aborted).toBe(true);
      expect(rpcSourceTesting.get(runId)).toBe(source);
      expect(mockCallArg(abortRespond)).toBe(true);
      expectRecordFields(mockCallArg(abortRespond, 0, 1), {
        aborted: true,
        runIds: [runId],
      });

      expectRecordFields(context.dedupe.get(`agent:${runId}`)?.payload, {
        runId,
        sessionKey: "global",
        agentId: "work",
        status: "timeout",
        summary: "aborted",
        stopReason: "rpc",
      });

      releaseSessionWrite?.();
      await pending;
      await flushScheduledDispatchStep();

      expect(mocks.agentCommand).not.toHaveBeenCalled();
      expect(rpcSourceTesting.has(runId)).toBe(false);
      const finalResponse = respond.mock.calls.find(
        (call: unknown[]) => (call[1] as { status?: unknown } | undefined)?.status === "timeout",
      );
      expectRecordFields(requireValue(finalResponse, "terminal response missing")[1], {
        runId,
        status: "timeout",
        stopReason: "rpc",
      });
    } finally {
      const settlement = captureAgentRunSettlement(runId);
      agentResult.resolve({ payloads: [], meta: { durationMs: 1 } });
      releaseSessionWrite?.();
      await Promise.allSettled([pending, cancellation]);
      await flushScheduledDispatchStep();
      await settlement;
      await captureAgentRunSettlement(runId);
    }
  });

  it("does not dispatch when a stop command lands during pre-accept setup", async () => {
    prime();
    const requestedSessionKey = "agent:main:legacy-main";
    const sessionWrite = holdFirstMainSessionWrite();
    const agentResult = createDeferred<HeldAgentResult>();
    mocks.agentCommand.mockReturnValueOnce(agentResult.promise);

    const context = makeContext();
    const respond = vi.fn();
    const runId = "idem-stop-before-registration";
    const pending = invokeAgent(
      {
        message: "hi",
        agentId: "main",
        sessionKey: requestedSessionKey,
        idempotencyKey: runId,
      },
      { context, respond, reqId: runId, flushDispatch: false },
    );
    let cancellation: Promise<void> | undefined;
    try {
      await waitForAssertion(() => expect(sessionWrite.calls).toBe(1));
      const source = expectPreparingAgentSource(runId, {
        sessionKey: "agent:main:main",
        sessionId: "existing-session-id",
        agentId: "main",
      });
      expectMainAlias(context.dedupe.get(`agent:${runId}`)?.payload, runId, requestedSessionKey);

      const stopRespond = vi.fn();
      cancellation = handleDirectExternalChatSend({
        params: {
          sessionKey: requestedSessionKey,
          message: "/stop",
          idempotencyKey: "idem-stop-command-before-registration",
        },
        respond: stopRespond as never,
        context,
        req: { type: "req", id: "stop-req", method: "chat.send" },
        client: null,
        isWebchatConnect: () => false,
      });
      await cancellation;
      expect(source.input.abortSignal.aborted).toBe(true);
      expect(isAgentRunDirectAbortReason(source.input.abortSignal.reason)).toBe(true);
      expect(rpcSourceTesting.get(runId)).toBe(source);
      expect(stopRespond).toHaveBeenCalledWith(
        true,
        expect.objectContaining({ aborted: true, runIds: [runId] }),
      );

      expectRecordFields(context.dedupe.get(`agent:${runId}`)?.payload, {
        runId,
        sessionKey: "agent:main:main",
        status: "timeout",
        summary: "aborted",
        stopReason: "stop",
      });

      sessionWrite.release();
      await pending;
      await flushScheduledDispatchStep();

      expect(mocks.agentCommand).not.toHaveBeenCalled();
      expect(rpcSourceTesting.has(runId)).toBe(false);
      const finalResponse = respond.mock.calls.find(
        (call: unknown[]) => (call[1] as { status?: unknown } | undefined)?.status === "timeout",
      );
      expectRecordFields(requireValue(finalResponse, "terminal response missing")[1], {
        runId,
        status: "timeout",
        stopReason: "stop",
      });
    } finally {
      const settlement = captureAgentRunSettlement(runId);
      agentResult.resolve({ payloads: [], meta: { durationMs: 1 } });
      sessionWrite.release();
      await Promise.allSettled([pending, cancellation]);
      await flushScheduledDispatchStep();
      await settlement;
      await captureAgentRunSettlement(runId);
    }
  });

  it("does not dispatch when session-level chat.abort lands during pre-accept setup", async () => {
    prime();
    const sessionWrite = holdFirstMainSessionWrite();
    const agentResult = createDeferred<HeldAgentResult>();
    mocks.agentCommand.mockReturnValueOnce(agentResult.promise);

    const context = makeContext();
    const respond = vi.fn();
    const runId = "idem-session-level-abort-before-registration";
    const pending = invokeAgent(
      {
        message: "hi",
        agentId: "main",
        sessionKey: "agent:main:main",
        idempotencyKey: runId,
      },
      { context, respond, reqId: runId, flushDispatch: false },
    );
    let cancellation: Promise<void> | undefined;
    try {
      await waitForAssertion(() => expect(sessionWrite.calls).toBe(1));
      const source = expectPreparingAgentSource(runId, {
        sessionKey: "agent:main:main",
        sessionId: "existing-session-id",
        agentId: "main",
      });

      const abortRespond = vi.fn();
      cancellation = handleChatAbortRequest({
        params: { sessionKey: "agent:main:main" },
        respond: abortRespond as never,
        context,
        req: { type: "req", id: "abort-req", method: "chat.abort" },
        client: null,
        isWebchatConnect: () => false,
      });
      await cancellation;
      expect(source.input.abortSignal.aborted).toBe(true);
      expect(rpcSourceTesting.get(runId)).toBe(source);
      expect(mockCallArg(abortRespond)).toBe(true);
      expectRecordFields(mockCallArg(abortRespond, 0, 1), {
        aborted: true,
        runIds: [runId],
      });

      expectRecordFields(context.dedupe.get(`agent:${runId}`)?.payload, {
        runId,
        sessionKey: "agent:main:main",
        status: "timeout",
        summary: "aborted",
        stopReason: "rpc",
      });

      sessionWrite.release();
      await pending;
      await flushScheduledDispatchStep();

      expect(mocks.agentCommand).not.toHaveBeenCalled();
      expect(rpcSourceTesting.has(runId)).toBe(false);
      const finalResponse = respond.mock.calls.find(
        (call: unknown[]) => (call[1] as { status?: unknown } | undefined)?.status === "timeout",
      );
      expectRecordFields(requireValue(finalResponse, "terminal response missing")[1], {
        runId,
        status: "timeout",
        stopReason: "rpc",
      });
    } finally {
      const settlement = captureAgentRunSettlement(runId);
      agentResult.resolve({ payloads: [], meta: { durationMs: 1 } });
      sessionWrite.release();
      await Promise.allSettled([pending, cancellation]);
      await flushScheduledDispatchStep();
      await settlement;
      await captureAgentRunSettlement(runId);
    }
  });

  it("does not dispatch when chat.abort lands during slow attachment setup", async () => {
    mockMainSessionEntry({
      sessionId: "existing-session-id",
      model: "vision-model",
      modelProvider: "test",
      providerOverride: "test",
      modelOverride: "vision-model",
    });
    mocks.updateSessionStore.mockResolvedValue(undefined);
    const agentResult = createDeferred<HeldAgentResult>();
    mocks.agentCommand.mockReturnValueOnce(agentResult.promise);

    const { context, releaseCatalog } = createHeldVisionCatalog();
    const respond = vi.fn();
    const runId = "idem-abort-during-attachment-setup";
    const pending = invokeAgent(
      {
        message: "inspect this",
        agentId: "main",
        sessionKey: "agent:main:main",
        idempotencyKey: runId,
        attachments: pixelAttachments(),
      },
      { context, respond, reqId: runId, flushDispatch: false },
    );

    let cancellation: Promise<void> | undefined;
    try {
      await waitForAssertion(() =>
        expectRecordFields(context.dedupe.get(`agent:${runId}`)?.payload, {
          runId,
          sessionKey: "agent:main:main",
          status: "accepted",
        }),
      );
      await waitForAssertion(() => expect(context.loadGatewayModelCatalog).toHaveBeenCalled());
      const source = expectPreparingAgentSource(runId, {
        sessionKey: "agent:main:main",
        sessionId: "existing-session-id",
        agentId: "main",
      });

      const abortRespond = vi.fn();
      cancellation = handleChatAbortRequest({
        params: { sessionKey: "agent:main:main", runId },
        respond: abortRespond as never,
        context,
        req: { type: "req", id: "abort-req", method: "chat.abort" },
        client: null,
        isWebchatConnect: () => false,
      });
      await cancellation;
      expect(source.input.abortSignal.aborted).toBe(true);
      expect(rpcSourceTesting.get(runId)).toBe(source);
      expect(mockCallArg(abortRespond)).toBe(true);
      expectRecordFields(mockCallArg(abortRespond, 0, 1), {
        aborted: true,
        runIds: [runId],
      });

      expectRecordFields(context.dedupe.get(`agent:${runId}`)?.payload, {
        runId,
        sessionKey: "agent:main:main",
        status: "timeout",
        summary: "aborted",
        stopReason: "rpc",
      });

      releaseCatalog();
      await pending;
      await flushScheduledDispatchStep();

      expect(mocks.agentCommand).not.toHaveBeenCalled();
      expect(rpcSourceTesting.has(runId)).toBe(false);
      const finalResponse = respond.mock.calls.find(
        (call: unknown[]) => (call[1] as { status?: unknown } | undefined)?.status === "timeout",
      );
      expectRecordFields(requireValue(finalResponse, "terminal response missing")[1], {
        runId,
        status: "timeout",
        stopReason: "rpc",
      });
    } finally {
      const settlement = captureAgentRunSettlement(runId);
      agentResult.resolve({ payloads: [], meta: { durationMs: 1 } });
      releaseCatalog();
      await Promise.allSettled([pending, cancellation]);
      await flushScheduledDispatchStep();
      await settlement;
      await captureAgentRunSettlement(runId);
    }
  });

  it("does not recreate a session deleted during slow attachment setup", async () => {
    const sessionKey = "agent:main:main";
    const persistedEntry = {
      sessionId: "existing-session-id",
      updatedAt: Date.now(),
      model: "vision-model",
      modelProvider: "test",
      providerOverride: "test",
      modelOverride: "vision-model",
    };
    let deleted = false;
    mocks.loadSessionEntry.mockImplementation(() => ({
      cfg: {},
      storePath: getAgentTestStorePath(),
      entry: deleted ? undefined : persistedEntry,
      canonicalKey: sessionKey,
    }));
    mocks.updateSessionStore.mockClear();
    mocks.agentCommand.mockClear();

    const { context, releaseCatalog } = createHeldVisionCatalog();
    const respond = vi.fn();
    const runId = "idem-delete-during-attachment-setup";
    const pending = invokeAgent(
      {
        message: "inspect this",
        agentId: "main",
        sessionKey,
        idempotencyKey: runId,
        attachments: pixelAttachments(),
      },
      { context, respond, reqId: runId, flushDispatch: false },
    );

    await waitForAssertion(() => expect(context.loadGatewayModelCatalog).toHaveBeenCalled());
    deleted = true;
    releaseCatalog();
    await pending;

    expectRespondError(respond, {
      message: `Session "${sessionKey}" was deleted while starting work. Retry.`,
    });
    expect(mocks.updateSessionStore).not.toHaveBeenCalled();
    expect(mocks.agentCommand).not.toHaveBeenCalled();
  });

  it("does not dispatch into a session reset during slow attachment setup", async () => {
    const sessionKey = "agent:main:main";
    const persistedEntry = {
      sessionId: "existing-session-id",
      updatedAt: Date.now(),
      model: "vision-model",
      modelProvider: "test",
      providerOverride: "test",
      modelOverride: "vision-model",
    };
    let currentEntry = persistedEntry;
    mocks.loadSessionEntry.mockImplementation(() => ({
      cfg: {},
      storePath: getAgentTestStorePath(),
      entry: currentEntry,
      canonicalKey: sessionKey,
    }));
    mocks.updateSessionStore.mockClear();
    mocks.agentCommand.mockClear();

    const { context, releaseCatalog } = createHeldVisionCatalog();
    const respond = vi.fn();
    const runId = "idem-reset-during-attachment-setup";
    const pending = invokeAgent(
      {
        message: "inspect this",
        agentId: "main",
        sessionKey,
        idempotencyKey: runId,
        attachments: pixelAttachments(),
      },
      { context, respond, reqId: runId, flushDispatch: false },
    );

    await waitForAssertion(() => expect(context.loadGatewayModelCatalog).toHaveBeenCalled());
    currentEntry = { ...persistedEntry, sessionId: "reset-session-id" };
    releaseCatalog();
    await pending;

    expectRespondError(respond, {
      message: `Session "${sessionKey}" changed while starting work. Retry.`,
    });
    expect(mocks.updateSessionStore).not.toHaveBeenCalled();
    expect(mocks.agentCommand).not.toHaveBeenCalled();
  });

  it("keeps selected-global agent scope while aborting during attachment setup", async () => {
    mocks.listAgentIds.mockReturnValue(["main", "work"]);
    mocks.loadSessionEntry.mockReturnValue({
      cfg: {},
      agentId: "work",
      storePath: getAgentTestStorePath(),
      entry: {
        sessionId: "work-global-session-id",
        updatedAt: Date.now(),
        modelProvider: "test",
        model: "vision-model",
        providerOverride: "test",
        modelOverride: "vision-model",
      },
      canonicalKey: "global",
    });
    mocks.updateSessionStore.mockResolvedValue(undefined);
    const agentResult = createDeferred<HeldAgentResult>();
    mocks.agentCommand.mockReturnValueOnce(agentResult.promise);

    const { context, releaseCatalog } = createHeldVisionCatalog();
    const respond = vi.fn();
    const runId = "idem-selected-global-abort-during-attachment-setup";
    const pending = invokeAgent(
      {
        message: "inspect this",
        agentId: "work",
        sessionKey: "global",
        idempotencyKey: runId,
        attachments: pixelAttachments(),
      },
      { context, respond, reqId: runId, flushDispatch: false },
    );

    let cancellation: Promise<void> | undefined;
    try {
      await waitForAssertion(() =>
        expectRecordFields(context.dedupe.get(`agent:${runId}`)?.payload, {
          runId,
          sessionKey: "global",
          agentId: "work",
          status: "accepted",
        }),
      );
      await waitForAssertion(() => expect(context.loadGatewayModelCatalog).toHaveBeenCalled());
      expect(context.loadGatewayModelCatalog).toHaveBeenCalledWith({
        agentId: "work",
        readOnly: true,
      });
      const source = expectPreparingAgentSource(runId, {
        sessionKey: "global",
        sessionId: "work-global-session-id",
        agentId: "work",
      });

      const abortRespond = vi.fn();
      cancellation = handleChatAbortRequest({
        params: { sessionKey: "global", agentId: "work", runId },
        respond: abortRespond as never,
        context,
        req: { type: "req", id: "abort-selected-global-req", method: "chat.abort" },
        client: null,
        isWebchatConnect: () => false,
      });
      await cancellation;
      expect(source.input.abortSignal.aborted).toBe(true);
      expect(rpcSourceTesting.get(runId)).toBe(source);
      expect(mockCallArg(abortRespond)).toBe(true);
      expectRecordFields(mockCallArg(abortRespond, 0, 1), {
        aborted: true,
        runIds: [runId],
      });

      expectRecordFields(context.dedupe.get(`agent:${runId}`)?.payload, {
        runId,
        sessionKey: "global",
        agentId: "work",
        status: "timeout",
        summary: "aborted",
        stopReason: "rpc",
      });

      releaseCatalog();
      await pending;
      await flushScheduledDispatchStep();

      expect(mocks.agentCommand).not.toHaveBeenCalled();
      expect(rpcSourceTesting.has(runId)).toBe(false);
      const finalResponse = respond.mock.calls.find(
        (call: unknown[]) => (call[1] as { status?: unknown } | undefined)?.status === "timeout",
      );
      expectRecordFields(requireValue(finalResponse, "terminal response missing")[1], {
        runId,
        status: "timeout",
        stopReason: "rpc",
      });
    } finally {
      const settlement = captureAgentRunSettlement(runId);
      agentResult.resolve({ payloads: [], meta: { durationMs: 1 } });
      releaseCatalog();
      await Promise.allSettled([pending, cancellation]);
      await flushScheduledDispatchStep();
      await settlement;
      await captureAgentRunSettlement(runId);
    }
  });

  it("does not dispatch when chat.abort lands before voice wake reroutes the session", async () => {
    let releaseRouting: (() => void) | undefined;
    mocks.loadVoiceWakeRoutingConfig.mockImplementation(
      async () =>
        await new Promise((resolve) => {
          releaseRouting = () =>
            resolve({
              version: 1,
              defaultTarget: { mode: "current" },
              routes: [],
              updatedAtMs: 0,
            });
        }),
    );
    mocks.resolveVoiceWakeRouteByTrigger.mockReturnValue({ sessionKey: "agent:main:voice" });
    mocks.loadSessionEntry.mockImplementation((sessionKey: string) => ({
      cfg: {},
      storePath: getAgentTestStorePath(),
      entry: {
        sessionId: sessionKey === "agent:main:voice" ? "voice-session-id" : "main-session-id",
        updatedAt: Date.now(),
      },
      canonicalKey: sessionKey === "agent:main:voice" ? "agent:main:voice" : "agent:main:main",
    }));
    mocks.updateSessionStore.mockResolvedValue(undefined);
    const agentResult = createDeferred<HeldAgentResult>();
    mocks.agentCommand.mockReturnValueOnce(agentResult.promise);

    const context = makeContext();
    const client = { ...operatorWriteCliClient(), connId: "voice-routing-owner" };
    const respond = vi.fn();
    const runId = "idem-abort-before-voice-route";
    const pending = invokeAgent(
      {
        message: "wake up",
        sessionKey: "agent:main:main",
        voiceWakeTrigger: "robot wake",
        idempotencyKey: runId,
      },
      { context, respond, client, reqId: runId, flushDispatch: false },
    );

    try {
      await waitForAssertion(() => expect(releaseRouting).toBeTypeOf("function"));
      expectRecordFields(context.dedupe.get(`agent:${runId}`)?.payload, {
        runId,
        sessionKey: "agent:main:main",
        status: "accepted",
      });
      expect(rpcSourceTesting.has(runId)).toBe(false);

      const abortRespond = vi.fn();
      await handleChatAbortRequest({
        params: { sessionKey: "agent:main:main", runId },
        respond: abortRespond as never,
        context,
        req: { type: "req", id: "abort-req", method: "chat.abort" },
        client,
        isWebchatConnect: () => false,
      });

      expectRecordFields(mockCallArg(abortRespond, 0, 1), {
        aborted: true,
        runIds: [runId],
      });
      expectRecordFields(context.dedupe.get(`agent:${runId}`)?.payload, {
        runId,
        sessionKey: "agent:main:main",
        status: "timeout",
        summary: "aborted",
        stopReason: "rpc",
      });

      releaseRouting?.();
      await pending;
      await flushScheduledDispatchStep();

      expect(mocks.agentCommand).not.toHaveBeenCalled();
      expect(rpcSourceTesting.has(runId)).toBe(false);
      const finalResponse = respond.mock.calls.find(
        (call: unknown[]) => (call[1] as { status?: unknown } | undefined)?.status === "timeout",
      );
      expectRecordFields(requireValue(finalResponse, "terminal response missing")[1], {
        runId,
        status: "timeout",
        stopReason: "rpc",
      });
    } finally {
      const settlement = captureAgentRunSettlement(runId);
      agentResult.resolve({ payloads: [], meta: { durationMs: 1 } });
      releaseRouting?.();
      await pending;
      await flushScheduledDispatchStep();
      await settlement;
      await captureAgentRunSettlement(runId);
    }
  });

  it("does not commit or dispatch agent work prepared across a gateway restart", async () => {
    mocks.registerAgentRunContext.mockClear();
    let releaseRouting: (() => void) | undefined;
    mocks.loadVoiceWakeRoutingConfig.mockImplementation(
      async () =>
        await new Promise((resolve) => {
          releaseRouting = () =>
            resolve({
              version: 1,
              defaultTarget: { mode: "current" },
              routes: [],
              updatedAtMs: 0,
            });
        }),
    );
    mocks.resolveVoiceWakeRouteByTrigger.mockReturnValue({ sessionKey: "agent:main:voice" });
    mocks.loadSessionEntry.mockImplementation((sessionKey: string) => ({
      cfg: {},
      storePath: getAgentTestStorePath(),
      entry: {
        sessionId: sessionKey === "agent:main:voice" ? "voice-session-id" : "main-session-id",
        updatedAt: Date.now(),
      },
      canonicalKey: sessionKey === "agent:main:voice" ? "agent:main:voice" : "agent:main:main",
    }));
    const committed = vi.fn();
    mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
      const result = await updater({});
      committed();
      return result;
    });

    const context = makeContext();
    const respond = vi.fn();
    const runId = "idem-restart-during-voice-route";
    const pending = invokeAgent(
      {
        message: "wake up",
        sessionKey: "agent:main:main",
        voiceWakeTrigger: "robot wake",
        idempotencyKey: runId,
      },
      { context, respond, reqId: runId, flushDispatch: false },
    );
    await waitForAssertion(() => expect(releaseRouting).toBeTypeOf("function"));

    mocks.lifecycleGeneration = "post-restart-generation";
    releaseRouting?.();
    await expect(pending).rejects.toThrow("Agent run belongs to a stale gateway lifecycle");

    expect(rpcSourceTesting.has(runId)).toBe(false);
    expect(mocks.registerAgentRunContext).not.toHaveBeenCalled();
    expect(mocks.agentCommand).not.toHaveBeenCalled();
    expect(committed).not.toHaveBeenCalled();
    expect(context.dedupe.has(`agent:${runId}`)).toBe(false);
  });

  it("does not mutate a session after losing lifecycle ownership while waiting for its store", async () => {
    prime();
    let releaseSessionWrite: (() => void) | undefined;
    let updaterCompleted = false;
    mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
      await new Promise<void>((resolve) => {
        releaseSessionWrite = resolve;
      });
      const store = {
        "agent:main:main": buildExistingMainStoreEntry(),
      };
      const result = await updater(store);
      updaterCompleted = true;
      return result;
    });

    const context = makeContext();
    const respond = vi.fn();
    const runId = "idem-restart-during-session-write";
    const pending = invokeAgent(
      {
        message: "hi",
        sessionKey: "agent:main:main",
        idempotencyKey: runId,
      },
      { context, respond, reqId: runId, flushDispatch: false },
    );
    await waitForAssertion(() => expect(releaseSessionWrite).toBeTypeOf("function"));

    mocks.lifecycleGeneration = "post-restart-generation";
    releaseSessionWrite?.();
    await expect(pending).rejects.toThrow("Agent run belongs to a stale gateway lifecycle");

    expect(updaterCompleted).toBe(false);
    expect(mocks.agentCommand).not.toHaveBeenCalled();
    expect(context.dedupe.has(`agent:${runId}`)).toBe(false);
  });

  it("does not acknowledge a bare reset that loses lifecycle ownership", async () => {
    prime();
    let releaseReset: (() => void) | undefined;
    mocks.performGatewaySessionReset.mockImplementation(
      async (opts: { assertCurrent?: () => void }) => {
        await new Promise<void>((resolve) => {
          releaseReset = resolve;
        });
        opts.assertCurrent?.();
        return {
          ok: true,
          key: "agent:main:main",
          entry: { sessionId: "reset-session-id" },
        };
      },
    );

    const context = makeContext();
    const respond = vi.fn();
    const runId = "idem-restart-during-bare-reset";
    const pending = invokeAgent(
      {
        message: "/reset",
        sessionKey: "agent:main:main",
        idempotencyKey: runId,
      },
      {
        context,
        respond,
        reqId: runId,
        client: operatorWriteCliClient(["operator.admin"]),
      },
    );
    await waitForAssertion(() => expect(releaseReset).toBeTypeOf("function"));

    mocks.lifecycleGeneration = "post-restart-generation";
    releaseReset?.();
    await expect(pending).rejects.toThrow("Agent run belongs to a stale gateway lifecycle");

    expect(mocks.agentCommand).not.toHaveBeenCalled();
    expect(context.dedupe.has(`agent:${runId}`)).toBe(false);
    expect(
      respond.mock.calls.some(
        (call: unknown[]) => (call[1] as { result?: unknown } | undefined)?.result !== undefined,
      ),
    ).toBe(false);
  });

  it("rejects unauthorized chat.abort during pre-accept setup", async () => {
    prime();
    const sessionWrite = holdFirstMainSessionWrite();
    const agentResult = createDeferred<HeldAgentResult>();
    mocks.agentCommand.mockReturnValueOnce(agentResult.promise);

    const context = makeContext();
    const respond = vi.fn();
    const runId = "idem-abort-before-registration-unauthorized";
    const pending = invokeAgent(
      {
        message: "hi",
        agentId: "main",
        sessionKey: "agent:main:main",
        idempotencyKey: runId,
      },
      {
        context,
        respond,
        reqId: runId,
        flushDispatch: false,
        client: { ...operatorWriteCliClient(), connId: "owner-conn" },
      },
    );
    try {
      await waitForAssertion(() => expect(sessionWrite.calls).toBe(1));
      const source = expectPreparingAgentSource(runId, {
        sessionKey: "agent:main:main",
        sessionId: "existing-session-id",
        agentId: "main",
      });

      const abortRespond = vi.fn();
      await handleChatAbortRequest({
        params: { sessionKey: "agent:main:main", runId },
        respond: abortRespond as never,
        context,
        req: { type: "req", id: "abort-req", method: "chat.abort" },
        client: { ...operatorWriteCliClient(), connId: "other-conn" },
        isWebchatConnect: () => false,
      });

      expect(source.input.abortSignal.aborted).toBe(false);
      expect(rpcSourceTesting.get(runId)).toBe(source);
      expect(mockCallArg(abortRespond, 0, 0)).toBe(false);
      expectRecordFields(mockCallArg(abortRespond, 0, 2), {
        code: "INVALID_REQUEST",
        message: "unauthorized",
      });
      expectRecordFields(context.dedupe.get(`agent:${runId}`)?.payload, {
        runId,
        sessionKey: "agent:main:main",
        status: "accepted",
      });

      sessionWrite.release();
      await pending;
      await flushScheduledDispatchStep();

      expect(mocks.agentCommand).toHaveBeenCalledTimes(1);
      expect(rpcSourceTesting.has(runId)).toBe(true);
    } finally {
      const settlement = captureAgentRunSettlement(runId);
      agentResult.resolve({ payloads: [], meta: { durationMs: 1 } });
      sessionWrite.release();
      await pending;
      await flushScheduledDispatchStep();
      await settlement;
      await captureAgentRunSettlement(runId);
    }
  });

  it("updates exec approval followup aliases when chat.abort lands during pre-accept setup", async () => {
    const { registration: firstRegistration, secondRegistration } =
      createElevatedExecApprovalFixture("req-elevated-preaccept-abort", 2);
    if (!firstRegistration || !secondRegistration) {
      throw new Error("expected runtime handoff ids");
    }
    mockTelegramSessionEntry();
    let releaseSessionWrite: (() => void) | undefined;
    let sessionWriteCalls = 0;
    mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
      sessionWriteCalls += 1;
      if (sessionWriteCalls === 1) {
        await new Promise<void>((resolve) => {
          releaseSessionWrite = resolve;
        });
      }
      const store = {
        "agent:main:main": buildExistingMainStoreEntry({
          lastChannel: "telegram",
          lastTo: "123",
        }),
      };
      return await updater(store);
    });
    const agentResult = createDeferred<HeldAgentResult>();
    mocks.agentCommand.mockReturnValue(agentResult.promise);
    const context = makeContext();
    const client = { ...backendGatewayClient(), connId: "exec-followup-owner" };
    const runId = firstRegistration.idempotencyKey;
    const aliasKey = "agent:exec-approval-followup:req-elevated-preaccept-abort";

    const pending = invokeAgent(
      {
        message: "exec followup",
        sessionKey: "agent:main:telegram:direct:123",
        channel: "telegram",
        idempotencyKey: runId,
        internalRuntimeHandoffId: firstRegistration.handoffId,
      },
      {
        reqId: "exec-followup-preaccept-abort-1",
        client,
        context,
        flushDispatch: false,
      },
    );
    let abortPending: Promise<void> | undefined;
    try {
      await waitForAssertion(() => expect(sessionWriteCalls).toBe(1));
      const source = expectPreparingAgentSource(runId, {
        sessionKey: "agent:main:main",
        sessionId: "existing-session-id",
        agentId: "main",
      });
      expectMainAlias(
        context.dedupe.get(aliasKey)?.payload,
        runId,
        "agent:main:telegram:direct:123",
      );

      const abortRespond = vi.fn();
      abortPending = handleChatAbortRequest({
        params: { sessionKey: "agent:main:telegram:direct:123", runId },
        respond: abortRespond as never,
        context,
        req: { type: "req", id: "abort-req", method: "chat.abort" },
        client,
        isWebchatConnect: () => false,
      });

      await abortPending;
      expect(source.input.abortSignal.aborted).toBe(true);
      expect(rpcSourceTesting.get(runId)).toBe(source);
      expect(mockCallArg(abortRespond)).toBe(true);
      expectRecordFields(mockCallArg(abortRespond, 0, 1), {
        aborted: true,
        runIds: [runId],
      });
      expectRecordFields(context.dedupe.get(`agent:${runId}`)?.payload, {
        runId,
        status: "timeout",
        stopReason: "rpc",
      });
      expectRecordFields(context.dedupe.get(aliasKey)?.payload, {
        runId,
        status: "timeout",
        stopReason: "rpc",
      });

      releaseSessionWrite?.();
      await pending;

      const retryRespond = await invokeAgent(
        {
          message: "exec followup duplicate",
          sessionKey: "agent:main:telegram:direct:123",
          channel: "telegram",
          idempotencyKey: secondRegistration.idempotencyKey,
          internalRuntimeHandoffId: secondRegistration.handoffId,
        },
        {
          reqId: "exec-followup-preaccept-abort-2",
          client,
          context,
          flushDispatch: false,
        },
      );

      expect(mockCallArg(retryRespond, 0, 1)).toMatchObject({
        runId,
        status: "timeout",
        stopReason: "rpc",
      });
      expect(mocks.agentCommand).not.toHaveBeenCalled();
    } finally {
      const settlement = captureAgentRunSettlement(runId);
      agentResult.resolve({ payloads: [], meta: { durationMs: 1 } });
      releaseSessionWrite?.();
      await Promise.allSettled([pending, abortPending]);
      await flushScheduledDispatchStep();
      await settlement;
      await captureAgentRunSettlement(runId);
    }
  });

  it("starts the registered timeout only after dispatch admission resolves", async () => {
    prime();
    const context = makeContext();
    const runId = "idem-dispatch-admission-timeout-start";
    const sessionId = "existing-session-id";
    let nowMs = 1_000_000;
    const dateNow = vi.spyOn(Date, "now").mockImplementation(() => nowMs);
    const { promise: acquireStarted, resolve: markAcquireStarted } = createDeferred();
    const { promise: acquireReleased, resolve: releaseAcquire } = createDeferred();
    const sourceWork = createDeferred();
    type AdmittedRunAbort = Parameters<
      Parameters<typeof prepareAgentRunDispatch>[0]["setAdmittedRunAbort"]
    >[0];
    let registration: AdmittedRunAbort | undefined;

    try {
      const pending = prepareAgentRunDispatch({
        promptedAt: nowMs,
        sourceWork: sourceWork.promise,
        lifecycleStorePath: getAgentTestStorePath(),
        request: {
          message: "wait for dispatch admission",
          timeout: 120,
          idempotencyKey: runId,
        },
        cfg: {},
        sessionEntry: { sessionId, updatedAt: nowMs },
        resolvedSessionKey: "agent:main:main",
        activeSessionAgentId: "main",
        delivery: {} as never,
        allowModelOverride: false,
        lifecycleGeneration: "test-generation",
        getAdmittedSessionId: () => sessionId,
        suppressVisibleSessionEffects: false,
        isOneShotModelRun: false,
        runId,
        agentDedupeKeys: [`agent:${runId}`],
        context,
        client: null,
        io: createAgentTurnIo(vi.fn()),
        acquireGatewayWorkAdmission: async () => {
          markAcquireStarted();
          await acquireReleased;
        },
        assertGatewayWorkAdmissionAllowed: () => {},
        hasGatewayAdmissionOutcome: () => false,
        respondToGatewayAdmissionOutcome: () => true,
        admissionAgentId: () => "main",
        getGatewayWorkAdmission: () => undefined,
        setAdmittedRunAbort: (value: AdmittedRunAbort) => {
          registration = value;
        },
        getAdmittedRunAbort: () => registration,
        markAgentRunAccepted: () => {},
      } as unknown as Parameters<typeof prepareAgentRunDispatch>[0]);

      await acquireStarted;
      expect(registration).toBeUndefined();
      nowMs += 90_000;
      releaseAcquire();
      await pending;

      const abortEntry = requireValue(registration?.entry, "chat abort entry missing");
      expect(sourceQueuedAt(abortEntry)).toBe(nowMs);
      expect(sourceExpiry(abortEntry)).toBe(
        resolveAgentRunExpiresAtMs({ now: nowMs, timeoutMs: 120_000 }),
      );
    } finally {
      releaseAcquire();
      const settlement = registration?.entry?.input.settlement.promise;
      const ownerSettlement = registration?.entry?.input.claim?.operation?.ownerSettlement;
      sourceWork.resolve();
      registration?.cleanup();
      await Promise.all([settlement, ownerSettlement]);
      dateNow.mockRestore();
    }
  });

  it("uses the explicit no-timeout agent expiry instead of the chat 24h cap", async () => {
    prime();
    const agentResult = createDeferred<HeldAgentResult>();
    let settlement: Promise<void> | undefined;
    let onExecutionStarted: (() => void | Promise<void>) | undefined;
    mocks.agentCommand.mockImplementation(
      (opts: { onExecutionStarted?: () => void | Promise<void> }) => {
        onExecutionStarted = opts.onExecutionStarted;
        return agentResult.promise;
      },
    );

    const context = makeContext();
    const respond = vi.fn();
    const runId = "idem-abort-no-timeout";
    try {
      await invokeAgent(
        {
          message: "hi",
          agentId: "main",
          sessionKey: "agent:main:main",
          idempotencyKey: runId,
          timeout: 0,
        },
        { context, respond, reqId: runId },
      );

      const entry = rpcSourceTesting.get(runId);
      const abortEntry = requireValue(entry, "chat abort entry missing");
      settlement = captureAgentRunSettlement(runId);
      expect(sourceExpiry(abortEntry) - sourceQueuedAt(abortEntry)).toBeGreaterThan(
        24 * 60 * 60_000,
      );
      const startedAtMs = sourceQueuedAt(abortEntry);
      const executionStartedAtMs = Date.now() + 60_000;
      const dateNow = vi.spyOn(Date, "now").mockReturnValue(executionStartedAtMs);
      try {
        await requireValue(onExecutionStarted, "execution-start callback missing")();
        expect(sourceQueuedAt(abortEntry)).toBe(startedAtMs);
        expect(sourceExpiry(abortEntry) - executionStartedAtMs).toBeGreaterThan(24 * 60 * 60_000);
      } finally {
        dateNow.mockRestore();
      }
    } finally {
      const remaining = captureAgentRunSettlement(runId);
      agentResult.resolve({ payloads: [], meta: { durationMs: 1 } });
      await settlement;
      await remaining;
    }
  });

  it("starts and rearms the agent timeout at the actual gateway execution boundaries", async () => {
    prime();
    const sessionKey = "agent:main:main";
    const sessionId = "existing-session-id";
    const runId = "idem-agent-execution-timeout-boundaries";
    let nowMs = 1_000_000;
    const dateNow = vi.spyOn(Date, "now").mockImplementation(() => nowMs);
    let releaseMutation = () => {};
    const { promise: mutationStarted, resolve: markMutationStarted } = createDeferred();
    const mutation = runSessionMutation({
      policy: "wait",
      scope: getAgentTestStorePath(),
      identities: [sessionKey, sessionId],
      run: async () => {
        markMutationStarted();
        await new Promise<void>((resolve) => {
          releaseMutation = resolve;
        });
      },
    });
    await mutationStarted;
    const agentResult = createDeferred<HeldAgentResult>();
    let settlement: Promise<void> | undefined;
    let onExecutionStarted: (() => void | Promise<void>) | undefined;
    mocks.agentCommand.mockImplementation(
      (opts: { onExecutionStarted?: () => void | Promise<void> }) => {
        onExecutionStarted = opts.onExecutionStarted;
        return agentResult.promise;
      },
    );
    const context = makeContext();
    const respond = vi.fn();
    const admissionStartedAtMs = nowMs;
    const request = invokeAgent(
      {
        message: "wait for admission, then preserve a full execution timeout",
        agentId: "main",
        sessionKey,
        idempotencyKey: runId,
        timeout: 120,
      },
      { context, respond, reqId: runId },
    );

    try {
      await waitForAssertion(() => expect(context.dedupe.has(`agent:${runId}`)).toBe(true));
      expect(rpcSourceTesting.has(runId)).toBe(false);
      nowMs += 90_000;
      releaseMutation();
      await mutation;
      await request;
      await waitForAssertion(() => expect(mocks.agentCommand).toHaveBeenCalledTimes(1));

      const abortEntry = requireValue(rpcSourceTesting.get(runId), "chat abort entry missing");
      settlement = captureAgentRunSettlement(runId);
      expect(sourceQueuedAt(abortEntry)).toBe(nowMs);
      expect(sourceQueuedAt(abortEntry)).toBeGreaterThan(admissionStartedAtMs);
      expect(sourceExpiry(abortEntry)).toBe(
        resolveAgentRunExpiresAtMs({ now: sourceQueuedAt(abortEntry), timeoutMs: 120_000 }),
      );

      nowMs += 119_999;
      const executionStarted = requireValue(onExecutionStarted, "execution-start callback missing");
      await executionStarted();
      expect(sourceQueuedAt(abortEntry)).toBe(admissionStartedAtMs + 90_000);
      expect(sourceExpiry(abortEntry)).toBe(
        resolveAgentRunExpiresAtMs({ now: nowMs, timeoutMs: 120_000 }),
      );

      const firstExecutionExpiryMs = sourceExpiry(abortEntry);
      nowMs += 120_000;
      await executionStarted();
      expect(sourceQueuedAt(abortEntry)).toBe(admissionStartedAtMs + 90_000);
      expect(sourceExpiry(abortEntry)).toBe(firstExecutionExpiryMs);
    } finally {
      releaseMutation();
      await mutation;
      await request;
      const remaining = captureAgentRunSettlement(runId);
      agentResult.resolve({ payloads: [], meta: { durationMs: 1 } });
      await settlement;
      await remaining;
      dateNow.mockRestore();
    }
  });

  registerAgentAbortQueueDeadlineTest({ captureAgentRunSettlement, sourceQueuedAt, sourceExpiry });

  it("sets the maintenance expiry to the configured agent timeout, not the 24h chat default", async () => {
    prime();
    const agentResult = createDeferred<HeldAgentResult>();
    mocks.agentCommand.mockReturnValueOnce(agentResult.promise);

    mocks.loadConfigReturn = {
      agents: { defaults: { timeoutSeconds: 48 * 60 * 60 } },
    };
    const context = makeContext();
    const runId = "idem-abort-expires";
    const before = Date.now();
    try {
      await invokeAgent(
        {
          message: "hi",
          agentId: "main",
          sessionKey: "agent:main:main",
          idempotencyKey: runId,
        },
        { context, reqId: runId },
      );
      mocks.loadConfigReturn = {};

      const entry = rpcSourceTesting.get(runId);
      const abortEntry = requireValue(entry, "chat abort entry missing");
      // 48h configured timeout must not be silently truncated to the 24h
      // chat.send default cap baked into resolveChatRunExpiresAtMs. Assert
      // at least 25h to leave headroom above the 24h cap; the expected
      // value is ~48h.
      const TWENTY_FIVE_HOURS_MS = 25 * 60 * 60 * 1_000;
      expect(sourceExpiry(abortEntry) - before).toBeGreaterThan(TWENTY_FIVE_HOURS_MS);
    } finally {
      const settlement = captureAgentRunSettlement(runId);
      agentResult.resolve({ payloads: [], meta: { durationMs: 1 } });
      await settlement;
    }
  });

  registerAgentAbortRunExecutionTest();

  registerAgentAbortSubagentTests();

  registerAgentAbortStaleKeyExecutionTest();

  it("keeps the sessions.abort wait snapshot after late agent completion", async () => {
    prime();
    let capturedSignal: AbortSignal | undefined;
    const agentResult = createDeferred<HeldAgentResult>();
    const abortObserved = createDeferred();
    let settlement: Promise<void> | undefined;
    let abort: Promise<void> | undefined;
    mocks.agentCommand.mockImplementationOnce((opts: { abortSignal?: AbortSignal }) => {
      capturedSignal = opts.abortSignal;
      capturedSignal?.addEventListener("abort", () => abortObserved.resolve(), { once: true });
      return agentResult.promise;
    });

    const context = makeContext();
    const runId = "idem-abort-snapshot-wins";
    try {
      await invokeAgent(
        {
          message: "hi",
          agentId: "main",
          sessionKey: "agent:main:main",
          idempotencyKey: runId,
        },
        { context, reqId: runId },
      );

      settlement = captureAgentRunSettlement(runId);

      const abortRespond = vi.fn();
      abort = handleChatAbortRequest({
        params: { sessionKey: "agent:main:main", runId },
        respond: abortRespond as never,
        context,
        req: { type: "req", id: "abort-req", method: "chat.abort" },
        client: null,
        isWebchatConnect: () => false,
      });
      await Promise.race([abortObserved.promise, abort]);
      expect(capturedSignal?.aborted).toBe(true);
      expect(abortRespond).not.toHaveBeenCalled();

      setGatewayDedupeEntry({
        dedupe: context.dedupe,
        key: `agent:${runId}`,
        entry: {
          ts: 100,
          ok: true,
          payload: {
            runId,
            status: "timeout",
            stopReason: "rpc",
            endedAt: 100,
          },
        },
      });

      agentResult.resolve({ payloads: [{ text: "late ok" }], meta: { durationMs: 1 } });
      await abort;
      await settlement;

      await waitForAssertion(() => {
        expectRecordFields(context.dedupe.get(`agent:${runId}`)?.payload, {
          runId,
          status: "timeout",
          stopReason: "rpc",
          endedAt: 100,
        });
      });
    } finally {
      const remaining = captureAgentRunSettlement(runId);
      agentResult.resolve({ payloads: [{ text: "late ok" }], meta: { durationMs: 1 } });
      await Promise.allSettled([abort]);
      await settlement;
      await remaining;
    }
  });

  it("chat.abort without runId aborts the active agent run for the sessionKey", async () => {
    prime();
    const agentResult = createDeferred<HeldAgentResult>();
    const abortObserved = createDeferred();
    let settlement: Promise<void> | undefined;
    let abort: Promise<void> | undefined;
    let capturedSignal: AbortSignal | undefined;
    mocks.agentCommand.mockImplementationOnce((opts: { abortSignal?: AbortSignal }) => {
      capturedSignal = opts.abortSignal;
      capturedSignal?.addEventListener("abort", () => abortObserved.resolve(), { once: true });
      return agentResult.promise;
    });

    const context = makeContext();
    const runId = "idem-abort-session";
    try {
      await invokeAgent(
        {
          message: "hi",
          agentId: "main",
          sessionKey: "agent:main:main",
          idempotencyKey: runId,
        },
        { context, reqId: runId },
      );

      settlement = captureAgentRunSettlement(runId);

      const abortRespond = vi.fn();
      abort = handleChatAbortRequest({
        params: { sessionKey: "agent:main:main" },
        respond: abortRespond as never,
        context,
        req: { type: "req", id: "abort-req", method: "chat.abort" },
        client: null,
        isWebchatConnect: () => false,
      });

      await Promise.race([abortObserved.promise, abort]);
      expect(capturedSignal?.aborted).toBe(true);
      expect(abortRespond).not.toHaveBeenCalled();
      agentResult.resolve({ payloads: [], meta: { durationMs: 1 } });
      await abort;
      expect(mockCallArg(abortRespond)).toBe(true);
      expectRecordFields(mockCallArg(abortRespond, 0, 1), {
        aborted: true,
        runIds: [runId],
      });
    } finally {
      const remaining = captureAgentRunSettlement(runId);
      agentResult.resolve({ payloads: [], meta: { durationMs: 1 } });
      await Promise.allSettled([abort]);
      await settlement;
      await remaining;
    }
  });

  it("removes the rpcSourceTesting entry after the run completes successfully", async () => {
    prime();
    mocks.agentCommand.mockResolvedValueOnce({
      payloads: [{ text: "ok" }],
      meta: { durationMs: 1 },
    });

    const context = makeContext();
    const runId = "idem-abort-cleanup-ok";
    await invokeAgent(
      {
        message: "hi",
        agentId: "main",
        sessionKey: "agent:main:main",
        idempotencyKey: runId,
      },
      { context, reqId: runId },
    );

    await waitForAssertion(() => {
      expect(rpcSourceTesting.has(runId)).toBe(false);
    });
  });

  it("retains agent RPC registration until terminal persistence settles", async () => {
    prime();
    const agentResult = createDeferred<HeldAgentResult>();
    const persistence = createDeferred();
    let settlement: Promise<void> | undefined;
    mocks.agentCommand.mockReturnValueOnce(agentResult.promise);

    const context = makeContext();
    const runId = "idem-abort-cleanup-persisting";
    try {
      await invokeAgent(
        {
          message: "hi",
          agentId: "main",
          sessionKey: "agent:main:main",
          idempotencyKey: runId,
        },
        { context, reqId: runId },
      );

      const entry = requireValue(rpcSourceTesting.get(runId), "chat abort entry missing");
      settlement = captureAgentRunSettlement(runId);
      entry.adapter.projectSessionTerminalPersistence = persistence.promise;
      agentResult.resolve({ payloads: [{ text: "ok" }], meta: { durationMs: 1 } });

      await waitForAssertion(() => {
        expect(rpcSourceTesting.has(runId)).toBe(true);
      });
      persistence.resolve();
      await settlement;
      await waitForAssertion(() => {
        expect(rpcSourceTesting.has(runId)).toBe(false);
      });
    } finally {
      const remaining = captureAgentRunSettlement(runId);
      agentResult.resolve({ payloads: [{ text: "ok" }], meta: { durationMs: 1 } });
      persistence.resolve();
      await settlement;
      await remaining;
    }
  });

  it("removes the rpcSourceTesting entry after the run errors", async () => {
    prime();
    mocks.clearAgentRunContext.mockClear();
    mocks.agentCommand.mockRejectedValueOnce(new Error("boom"));

    const context = makeContext();
    const runId = "idem-abort-cleanup-err";
    await invokeAgent(
      {
        message: "hi",
        agentId: "main",
        sessionKey: "agent:main:main",
        idempotencyKey: runId,
      },
      { context, reqId: runId },
    );

    await waitForAssertion(() => {
      expect(rpcSourceTesting.has(runId)).toBe(false);
      expect(mocks.clearAgentRunContext).toHaveBeenCalledWith(runId, "test-generation");
    });
  });

  registerAgentPreDispatchFailureTests();

  it("does not dispatch a duplicate agent run when dedupe was evicted but the run is active", async () => {
    prime();
    mocks.agentCommand.mockResolvedValueOnce({
      payloads: [{ text: "ok" }],
      meta: { durationMs: 1 },
    });

    const context = makeContext();
    const runId = "idem-abort-collision";
    const preExisting = createRpcSourceForTest(
      { requester: { connectionId: "chat-send-conn" } },
      {
        runId,
        storeScope: "/tmp/sessions.json",
        sessionId: "existing-session-id",
        sessionKey: "agent:main:main",
      },
    );
    rpcSourceTesting.set(runId, preExisting);
    context.dedupe.delete(`agent:${runId}`);
    mocks.registerAgentRunContext.mockClear();
    const respond = vi.fn();

    await invokeAgent(
      {
        message: "hi",
        agentId: "main",
        sessionKey: "agent:main:main",
        idempotencyKey: runId,
      },
      { context, reqId: runId, respond },
    );

    expect(rpcSourceTesting.get(runId)).toBe(preExisting);
    expect(context.dedupe.has(`agent:${runId}`)).toBe(false);
    expect(context.addChatRun).not.toHaveBeenCalled();
    expect(mocks.registerAgentRunContext).not.toHaveBeenCalled();
    expect(mocks.agentCommand).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(true, { runId, status: "in_flight" }, undefined, {
      cached: true,
      runId,
    });
  });

  it("does not dispatch a duplicate sessionless run while its reservation is active", async () => {
    prime();
    const dispatchGate = createDeferred();
    const dispatchYield = vi
      .spyOn(agentHandlerHelpers, "yieldAfterAgentAcceptedAck")
      .mockReturnValue(dispatchGate.promise);
    const agentResult = createDeferred<HeldAgentResult>();
    mocks.agentCommand.mockReturnValueOnce(agentResult.promise);

    const context = makeContext();
    const runId = "idem-sessionless-active-collision";
    const request = {
      message: "hi",
      agentId: "main",
      sessionId: "sessionless-existing-session",
      idempotencyKey: runId,
    };
    try {
      await invokeAgent(request, { context, reqId: runId, flushDispatch: false });
      expect(rpcSourceTesting.has(runId)).toBe(false);
      expect(mocks.agentCommand).not.toHaveBeenCalled();

      const duplicateRespond = vi.fn();
      await invokeAgent(request, {
        context,
        reqId: `${runId}-duplicate`,
        respond: duplicateRespond,
      });

      expect(mocks.agentCommand).not.toHaveBeenCalled();
      expect(duplicateRespond).toHaveBeenCalledWith(
        true,
        { runId, status: "in_flight", agentId: "main" },
        undefined,
        {
          cached: true,
          runId,
        },
      );

      dispatchGate.resolve();
      await waitForAssertion(() => expect(mocks.agentCommand).toHaveBeenCalledTimes(1));
    } finally {
      dispatchGate.resolve();
      agentResult.resolve({ payloads: [{ text: "ok" }], meta: { durationMs: 1 } });
      try {
        await waitForAssertion(() =>
          expectRecordFields(context.dedupe.get(`agent:${runId}`)?.payload, { status: "ok" }),
        );
      } finally {
        dispatchYield.mockRestore();
      }
    }
  });

  it("keeps a sessionless run from replacing an active projected run", async () => {
    prime();
    const context = makeContext();
    const runId = "idem-sessionless-projected-collision";
    const preExisting = createRpcSourceForTest(
      {},
      { runId, sessionId: "chat-send-session", sessionKey: "agent:main:main" },
    );
    rpcSourceTesting.set(runId, preExisting);
    const respond = vi.fn();

    await invokeAgent(
      {
        message: "hi",
        agentId: "main",
        sessionId: "sessionless-existing-session",
        idempotencyKey: runId,
      },
      { context, reqId: runId, respond },
    );

    expect(rpcSourceTesting.get(runId)).toBe(preExisting);
    expect(mocks.agentCommand).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(true, { runId, status: "in_flight" }, undefined, {
      cached: true,
      runId,
    });
  });

  it("returns in_flight instead of replaying cached accepted agent replies", async () => {
    prime();
    const dispatchGate = createDeferred();
    const dispatchYield = vi
      .spyOn(agentHandlerHelpers, "yieldAfterAgentAcceptedAck")
      .mockReturnValue(dispatchGate.promise);
    mocks.agentCommand.mockResolvedValueOnce({
      payloads: [{ text: "ok" }],
      meta: { durationMs: 1 },
    });
    const context = makeContext();
    const runId = "idem-cached-accepted";
    try {
      await invokeAgent(
        {
          message: "hi",
          agentId: "main",
          sessionKey: "agent:main:main",
          idempotencyKey: runId,
        },
        { context, reqId: runId, flushDispatch: false },
      );
      expectRecordFields(context.dedupe.get(`agent:${runId}`)?.payload, {
        runId,
        status: "accepted",
        sessionKey: "agent:main:main",
      });
      const duplicateRespond = vi.fn();
      await invokeAgent(
        {
          message: "hi again",
          agentId: "main",
          sessionKey: "agent:main:main",
          idempotencyKey: runId,
        },
        { context, reqId: `${runId}-duplicate`, respond: duplicateRespond },
      );
      expect(mocks.agentCommand.mock.calls.length).toBe(0);
      expect(duplicateRespond).toHaveBeenCalledWith(
        true,
        { runId, status: "in_flight", sessionKey: "agent:main:main", agentId: "main" },
        undefined,
        { cached: true, runId },
      );
    } finally {
      dispatchGate.resolve();
      try {
        await waitForAssertion(() => expect(rpcSourceTesting.has(runId)).toBe(false));
      } finally {
        dispatchYield.mockRestore();
      }
    }
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
