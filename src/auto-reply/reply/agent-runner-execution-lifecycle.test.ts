import { describe, expect, it, vi } from "vitest";
import { createChannelParticipantAdmissionEvidence } from "../../../test/helpers/channel-admission-evidence.js";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import type { CompactionAccountingFact } from "../../agents/embedded-agent-runner/run/internal-params.js";
import type { EmbeddedAgentQueueHandle } from "../../agents/embedded-agent-runner/runs.js";
import {
  clearTestEmbeddedRun as clearActiveEmbeddedRun,
  registerTestEmbeddedRun as setActiveEmbeddedRun,
} from "../../agents/embedded-agent-runner/runs.test-support.js";
import { createAgentRunDirectAbortError } from "../../agents/run-termination.js";
import { runWithAgentWorkspaceReadiness } from "../../agents/workspace-readiness.js";
import { configureExecutionIdentityAdmissionSink } from "../../audit/execution-identity-admission.js";
import { createChannelAdmissionAudit } from "../../channels/message-access/admission-evidence.js";
import { getDiagnosticSessionActivitySnapshot } from "../../logging/diagnostic-run-activity.js";
import { useBundledProviderPolicyArtifactsForTest } from "../../plugin-sdk/test-helpers/provider-policy-artifacts.test-support.js";
import {
  createReplyOperation,
  getSessionControllerOperation,
  type ReplyOperation,
} from "../../sessions/session-controller.js";
import { isSessionRunActive } from "../../sessions/session-controller.queries.js";
import { hasReplyOperationExecutionStarted } from "../../sessions/session-controller.state.js";
import {
  setupAgentRunnerExecutionTestState,
  getExecuteAgentTurnForTest,
  createMockTypingSignaler,
  createFollowupRun,
  createRunResult,
  runFallbackCandidate,
  fallbackAttemptOptions,
  initialFallbackAttemptOptions,
  createMockReplyOperation,
  requireRecord,
  expectMockCallArgFields,
  requireMockCall,
  createMinimalRunAgentTurnParams,
  getRawExecuteAgentTurnForTest,
} from "./agent-runner-execution.test-support.js";
import type {
  FallbackRunnerParams,
  EmbeddedAgentParams,
} from "./agent-runner-execution.test-support.js";
import type { AgentTurnParams } from "./agent-runner-execution.types.js";
import type { InternalGetReplyOptions } from "./get-reply.types.js";
import { withReplySystemEventContext } from "./system-event-session-key.js";

useBundledProviderPolicyArtifactsForTest(["openai", "anthropic"]);
const state = await setupAgentRunnerExecutionTestState();
const executeAgentTurn = await getExecuteAgentTurnForTest();
const executeRawAgentTurn = await getRawExecuteAgentTurnForTest();
const { emitAgentEvent } = await import("../../infra/agent-events.js");

function execute(
  params?: Parameters<typeof createMinimalRunAgentTurnParams>[0],
  overrides?: Partial<AgentTurnParams>,
) {
  return executeAgentTurn({ ...createMinimalRunAgentTurnParams(params), ...overrides });
}

function holdSettledFallback() {
  const candidateSettled = createDeferred();
  const fallbackRelease = createDeferred();
  state.runWithModelFallbackMock.mockImplementationOnce(async (params: FallbackRunnerParams) => {
    const result = await runFallbackCandidate(params, "anthropic", "claude");
    candidateSettled.resolve();
    await fallbackRelease.promise;
    return result;
  });
  return { candidateSettled, fallbackRelease };
}

function terminalEvents(runId?: string) {
  return vi
    .mocked(emitAgentEvent)
    .mock.calls.map(([event]) => event)
    .filter(
      (event) =>
        (runId === undefined || event.runId === runId) &&
        event.stream === "lifecycle" &&
        (event.data.phase === "end" || event.data.phase === "error"),
    );
}

const compactionTarget = {
  agentId: "main",
  sessionId: "session",
  sessionKey: "agent:main:main",
  storePath: "/tmp/compaction-accounting.sqlite",
  lifecycleRevision: "generation-1",
  activeWriterRunId: "run-compaction",
};

type DurableCompactionFact = Extract<CompactionAccountingFact, { kind: "durable" }>;
function compactionFact(
  count: number,
  tokens: number,
  target: DurableCompactionFact["target"] = compactionTarget,
): DurableCompactionFact {
  return { kind: "durable", count, currentContextSnapshot: { tokens }, target };
}

async function admitEmbeddedRun(params: EmbeddedAgentParams) {
  const admission = (
    params as EmbeddedAgentParams & {
      preparedRunAdmission: { admit: (kind: "embedded") => Promise<unknown> };
    }
  ).preparedRunAdmission;
  await admission.admit("embedded");
  return createRunResult("ok");
}

describe("executeAgentTurn: run lifecycle and ownership", () => {
  it("settles a tool-free response after failed workspace preparation", async () => {
    const ready = createDeferred();
    const waiting = createDeferred();
    const preparationError = new Error("Checkout failed; retry this session.");
    let failure: Error | undefined = undefined;
    const params = createMinimalRunAgentTurnParams();
    if (!params.sessionKey) {
      throw new Error("Expected the fixture session key");
    }
    state.runEmbeddedAgentMock.mockResolvedValueOnce(createRunResult("A response without tools."));
    vi.mocked(emitAgentEvent).mockClear();
    let completed = false;
    const pending = runWithAgentWorkspaceReadiness(
      {
        sessionKey: params.sessionKey,
        waitUntilReady: () => {
          waiting.resolve();
          return ready.promise;
        },
        assertCurrent: () => {},
        getFailure: () => failure,
      },
      () => executeRawAgentTurn(params),
    ).finally(() => {
      completed = true;
    });

    await Promise.race([waiting.promise, pending]);
    expect(state.runEmbeddedAgentMock).toHaveBeenCalledOnce();
    expect(completed).toBe(false);
    expect(terminalEvents()).toEqual([]);
    failure = preparationError;
    ready.reject(preparationError);
    await pending;
    expect(terminalEvents()).toHaveLength(1);
    expect(terminalEvents()[0]?.data).toMatchObject({
      phase: "error",
      error: preparationError.message,
    });
  });

  it("releases a deferred owner and retains private compaction facts when direct abort escapes", async () => {
    const onAgentRunTerminalOutcome = vi.fn();
    const fact = compactionFact(1, 40, { ...compactionTarget, sessionId: "accepted-successor" });
    const sessionId = "session";
    const sessionKey = "main";
    const handle: EmbeddedAgentQueueHandle = {
      runId: "restart-after-adoption",
      queueMessage: async () => undefined,
      isStreaming: () => true,
      isCompacting: () => false,
      abort: vi.fn(),
    };
    state.runEmbeddedAgentMock.mockImplementationOnce(async (params: EmbeddedAgentParams) => {
      // The native handle belongs to the turn already admitted by execution.
      setActiveEmbeddedRun(sessionId, handle, sessionKey);
      params.onDeferredLifecycleOwner?.({
        beginRetryWait: () => undefined,
        complete: async () => clearActiveEmbeddedRun(sessionId, handle, sessionKey),
        discard: () => clearActiveEmbeddedRun(sessionId, handle, sessionKey),
      });
      expect(params.onCompactionAccounting).toEqual(expect.any(Function));
      params.onCompactionAccounting?.(fact);
      throw createAgentRunDirectAbortError();
    });

    try {
      const result = await executeRawAgentTurn(
        createMinimalRunAgentTurnParams({ opts: { onAgentRunTerminalOutcome } }),
      );

      expect(result.outcome).toEqual({
        kind: "aborted",
        reason: "user",
        compaction: { count: 1, durable: [fact] },
      });
      expect(onAgentRunTerminalOutcome).not.toHaveBeenCalled();
      expect(isSessionRunActive(sessionId)).toBe(false);
      const terminals = terminalEvents(result.runId);
      expect(terminals).toHaveLength(1);
      expect(terminals[0]?.data).toMatchObject({
        phase: "error",
        aborted: true,
        stopReason: "aborted",
      });
    } finally {
      clearActiveEmbeddedRun(sessionId, handle, sessionKey);
    }
  });

  it("attributes one admitted channel participant before its admission decision", async () => {
    const order: string[] = [];
    const identityWork: unknown[] = [];
    const decisionReceipts: unknown[] = [];
    const audit = createChannelAdmissionAudit({
      enabled: true,
      decisionSink: (receipt) => {
        order.push("decision");
        decisionReceipts.push(receipt);
        return true;
      },
    });
    const clearIdentitySink = configureExecutionIdentityAdmissionSink((work) => {
      order.push("identity");
      identityWork.push(work);
      return true;
    });
    try {
      const followupRun = createFollowupRun();
      followupRun.run.config = { logging: { audit: { executionIdentity: true } } };
      followupRun.channelAdmissionEvidence = createChannelParticipantAdmissionEvidence({
        audit,
        channelId: "whatsapp",
        accountId: "default",
        participantId: "person-42",
      });
      state.runEmbeddedAgentMock.mockImplementationOnce(admitEmbeddedRun);

      await executeAgentTurn({
        ...createMinimalRunAgentTurnParams({ followupRun }),
      });

      expect(order).toEqual(["identity", "decision"]);
      expect(identityWork).toMatchObject([
        {
          kind: "capture",
          envelope: {
            ingress: { kind: "channel", state: "present" },
            invoker: {
              state: "present",
              kind: "person",
              rawPrincipalRef: '["whatsapp","default","person-42"]',
            },
          },
        },
      ]);
      expect(decisionReceipts).toMatchObject([
        {
          action: { family: "channel", operation: "admission" },
          enforcement: { coverageState: "attribution-only" },
        },
      ]);
    } finally {
      clearIdentitySink();
      audit.close();
    }
  });

  it("propagates reply aborts through fallback orchestration and candidates", async () => {
    const controller = new AbortController();
    const { replyOperation } = createMockReplyOperation({ abortSignal: controller.signal });
    state.runEmbeddedAgentMock.mockResolvedValueOnce(createRunResult("ok"));

    await execute({ replyOperation });

    const fallbackCall = requireRecord(
      state.runWithModelFallbackMock.mock.calls[0]?.[0],
      "runWithModelFallback params",
    );
    const embeddedCall = requireRecord(
      state.runEmbeddedAgentMock.mock.calls[0]?.[0],
      "runEmbeddedAgent params",
    );
    expect(fallbackCall.sessionId).toBe("session");
    expect(embeddedCall.abortSignal).toBe(fallbackCall.abortSignal);
    expect(embeddedCall.abortSignal).toMatchObject({ aborted: false });

    controller.abort();

    expect(fallbackCall.abortSignal).toMatchObject({ aborted: true });
    expect(embeddedCall.abortSignal).toMatchObject({ aborted: true });
  });

  it("records diagnostic progress from global-lane wait notifications", async () => {
    const replyOperation = createReplyOperation({
      sessionKey: "agent:main:global-lane-progress",
      sessionId: "global-lane-progress",
      resetTriggered: false,
    });
    replyOperation.markWaitingForGlobalLane();
    let progressReasonDuringWait: string | undefined;
    state.runEmbeddedAgentMock.mockImplementationOnce(async (params: EmbeddedAgentParams) => {
      params.onLaneWait?.({ waitMs: 5_000, queuedAhead: 4, waiting: true });
      progressReasonDuringWait = getDiagnosticSessionActivitySnapshot({
        sessionId: replyOperation.sessionId,
        sessionKey: replyOperation.key,
      }).lastProgressReason;
      return createRunResult("ok");
    });

    try {
      await execute({ replyOperation });

      expect(progressReasonDuringWait).toBe("global_lane:waiting");
    } finally {
      replyOperation.complete();
    }
  });

  it.each([
    { override: "default", requested: "ultra", expected: ["ultra", "ultra"] },
    { override: undefined, requested: "high", expected: ["high", "off"] },
  ] as const)(
    "revalidates original thinking for main-chat fallback with turn request=$requested",
    async ({ override, requested, expected }) => {
      const followupRun = createFollowupRun();
      followupRun.run.provider = "openai";
      followupRun.run.model = "gpt-5.6-sol";
      followupRun.run.thinkLevel = requested;
      followupRun.run.thinkingCatalog = [
        { provider: "openai", id: "gpt-5.6-sol", reasoning: true },
        { provider: "demo", id: "basic", reasoning: false },
      ];
      followupRun.run = { ...followupRun.run, thinkLevelOverride: override };
      followupRun.run.config = {
        agents: {
          defaults: {
            models: {
              "openai/gpt-5.6-sol": { agentRuntime: { id: "openclaw" } },
              "demo/basic": { agentRuntime: { id: "openclaw" } },
            },
          },
        },
      };
      state.runWithModelFallbackMock.mockImplementationOnce(
        async (params: FallbackRunnerParams) => {
          await params.run("openai", "gpt-5.6-sol", initialFallbackAttemptOptions(params));
          const result = await params.run(
            "demo",
            "basic",
            fallbackAttemptOptions(params, "unknown"),
          );
          return { result, provider: "demo", model: "basic", attempts: [] };
        },
      );
      state.runEmbeddedAgentMock.mockResolvedValue(createRunResult("ok"));

      const result = await execute({ followupRun });

      expect(state.runEmbeddedAgentMock.mock.calls.map((call) => call[0]?.thinkLevel)).toEqual(
        expected,
      );
      expect(followupRun.run.thinkLevel).toBe(requested);
      if (result.kind !== "success") {
        throw new Error("Expected a successful fallback");
      }
      expect(result.runResult.meta.requestShaping?.thinkingClamp).toBe(
        requested === "high"
          ? "Thinking level clamped to off for demo/basic (requested high; preference retained)."
          : undefined,
      );
    },
  );

  it("freezes abort ownership only after model fallback settles", async () => {
    const { replyOperation, freezeAbortMock } = createMockReplyOperation();
    const followupRun = createFollowupRun();
    followupRun.media = [{ path: "/tmp/retry.png", contentType: "image/png" }];
    state.runWithModelFallbackMock.mockImplementationOnce(async (params: FallbackRunnerParams) => {
      expect(freezeAbortMock).not.toHaveBeenCalled();
      await params
        .run("anthropic", "claude", initialFallbackAttemptOptions(params))
        .catch(() => undefined);
      expect(freezeAbortMock).not.toHaveBeenCalled();
      const result = await params.run(
        "openai",
        "gpt-5.5",
        fallbackAttemptOptions(params, "unknown"),
      );
      expect(freezeAbortMock).not.toHaveBeenCalled();
      return {
        result,
        provider: "openai",
        model: "gpt-5.5",
        attempts: [],
      };
    });
    state.runEmbeddedAgentMock
      .mockRejectedValueOnce(new Error("primary failed"))
      .mockResolvedValueOnce(createRunResult("ok"));

    await execute({ followupRun, replyOperation });

    expect(state.runEmbeddedAgentMock).toHaveBeenCalledTimes(2);
    expect(state.runEmbeddedAgentMock.mock.calls.map((call) => call[0]?.media)).toEqual([
      followupRun.media,
      followupRun.media,
    ]);
    expect(freezeAbortMock).toHaveBeenCalledTimes(1);
  });

  it("suppresses a settled fallback result after an accepted user abort", async () => {
    const { replyOperation, freezeAbortMock } = createMockReplyOperation();
    const abortController = new AbortController();
    let operationResult: ReplyOperation["result"] = null;
    const { candidateSettled, fallbackRelease } = holdSettledFallback();
    const pendingToolTask = createDeferred();
    const pendingToolTasks = new Set([pendingToolTask.promise]);
    Object.defineProperty(replyOperation, "abortSignal", {
      configurable: true,
      get: () => abortController.signal,
    });
    Object.defineProperty(replyOperation, "result", {
      configurable: true,
      get: () => operationResult,
    });
    replyOperation.abortByUser = vi.fn(() => {
      operationResult = { kind: "aborted", code: "aborted_by_user" };
      abortController.abort("user_abort");
      return true;
    });
    state.runEmbeddedAgentMock.mockResolvedValueOnce(createRunResult("late reply"));

    const pending = execute({ replyOperation }, { pendingToolTasks });
    await candidateSettled.promise;
    expect(replyOperation.abortByUser()).toBe(true);
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    fallbackRelease.resolve();
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(settled).toBe(false);
    expect(freezeAbortMock).not.toHaveBeenCalled();
    pendingToolTask.resolve();

    await expect(pending).resolves.toEqual({
      kind: "final",
      payload: {},
    });
    expect(freezeAbortMock).toHaveBeenCalledTimes(1);
  });

  it("preserves completed compaction without a reply after user abort", async () => {
    const upstreamAbort = new AbortController();
    const replyOperation = createReplyOperation({
      sessionKey: "agent:main:upstream-settled-fallback",
      sessionId: "session",
      resetTriggered: false,
      upstreamAbortSignal: upstreamAbort.signal,
    });
    replyOperation.setPhase("running");
    const { candidateSettled, fallbackRelease } = holdSettledFallback();
    state.runEmbeddedAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "late reply" }],
      meta: {
        agentMeta: {
          sessionId: "session",
          provider: "anthropic",
          model: "claude",
          compactionCount: 1,
          compactionTokensAfter: 40,
        },
      },
    });

    try {
      const params = createMinimalRunAgentTurnParams({ replyOperation });
      params.followupRun.run.sourceReplyDeliveryMode = "message_tool_only";
      const pending = executeRawAgentTurn(params);
      await candidateSettled.promise;
      upstreamAbort.abort(new Error("caller cancelled"));
      const expectedAbortResult = {
        kind: "aborted",
        code: "aborted_by_user",
      };
      expect(replyOperation.abortSignal.aborted).toBe(true);
      expect(replyOperation.result).toEqual(expectedAbortResult);
      expect(getSessionControllerOperation(replyOperation.key)).toBe(replyOperation);
      fallbackRelease.resolve();

      expect((await pending).outcome).toEqual({
        kind: "aborted",
        reason: "user",
        compaction: { count: 1, durable: [] },
      });
      expect(replyOperation.result).toEqual(expectedAbortResult);
      expect(getSessionControllerOperation(replyOperation.key)).toBe(replyOperation);
      expect(state.runEmbeddedAgentMock).toHaveBeenCalledOnce();
      expect(state.recordMessageToolRunOutcomeMock).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: "mute", runStatus: "aborted" }),
      );
    } finally {
      fallbackRelease.resolve();
      replyOperation.complete();
    }
    expect(getSessionControllerOperation(replyOperation.key)).toBeUndefined();
  });

  it.each([
    { name: "same-owner custody-only", owner: "same", currentContextSnapshot: undefined },
    { name: "unrelated writer", owner: "different", currentContextSnapshot: { tokens: 999 } },
  ] as const)(
    "aggregates fallback counts without borrowing $name context",
    async ({ owner, currentContextSnapshot }) => {
      const first = compactionFact(1, 80);
      const successor = compactionFact(3, 40, { ...compactionTarget, sessionId: "successor" });
      const otherWriter = compactionFact(1, 20, {
        ...compactionTarget,
        sessionId: "successor",
        activeWriterRunId: "other-writer",
      });
      const latest = compactionFact(1, 10, { ...compactionTarget, sessionId: "latest-successor" });
      const modelOnly: CompactionAccountingFact = {
        kind: "durable",
        count: 0,
        ...(currentContextSnapshot ? { currentContextSnapshot } : {}),
        target: {
          ...latest.target,
          activeWriterRunId:
            owner === "different" ? "unrelated-writer" : compactionTarget.activeWriterRunId,
        },
      };
      const facts = [first, undefined, successor, otherWriter, latest, undefined, modelOnly];
      for (const [index, fact] of facts.entries()) {
        state.runEmbeddedAgentMock.mockImplementationOnce(async (params: EmbeddedAgentParams) => {
          if (fact) {
            expect(params.onCompactionAccounting).toEqual(expect.any(Function));
            params.onCompactionAccounting?.(fact);
          }
          return {
            payloads: [{ text: "done" }],
            meta: {
              agentMeta: {
                compactionCount: fact ? 99 : index === 1 ? 2 : 0,
                lastCallUsage: { input: 777 },
                sessionId: "untrusted-model-id",
              },
            },
          };
        });
      }
      state.runWithModelFallbackMock.mockImplementationOnce(
        async (params: FallbackRunnerParams) => {
          let result = await params.run(
            "anthropic",
            "primary",
            initialFallbackAttemptOptions(params),
          );
          for (let index = 1; index < facts.length; index += 1) {
            result = await params.run(
              "anthropic",
              `fallback-${index}`,
              fallbackAttemptOptions(params, "unknown"),
            );
          }
          return { result, provider: "anthropic", model: "fallback-6", attempts: [] };
        },
      );

      const result = await executeRawAgentTurn(createMinimalRunAgentTurnParams());

      expect(result.outcome).toMatchObject({ kind: "settled", autoCompactionCount: 8 });
      expect(result.outcome.compaction).toEqual({
        count: 8,
        durable: [
          { ...otherWriter, currentContextSnapshot: { tokens: undefined } },
          {
            ...latest,
            count: 5,
            currentContextSnapshot:
              owner === "same" && currentContextSnapshot
                ? currentContextSnapshot
                : { tokens: undefined },
          },
        ],
      });
    },
  );

  it("signals typing and records the execution boundary before assistant text", async () => {
    const typingSignals = createMockTypingSignaler();
    const onAgentRunStart = vi.fn();
    const replyOperation = createReplyOperation({
      sessionKey: "agent:main:execution-boundary",
      sessionId: "execution-boundary",
      resetTriggered: false,
    });
    state.runEmbeddedAgentMock.mockImplementationOnce(async (params: EmbeddedAgentParams) => {
      expect(hasReplyOperationExecutionStarted(replyOperation)).toBe(false);
      await params.onAgentEvent?.({ stream: "lifecycle", data: { phase: "start" } });
      params.onExecutionPhase?.({
        phase: "model_call_started",
        provider: "openai",
        model: "gpt-5.4",
      });
      expect(hasReplyOperationExecutionStarted(replyOperation)).toBe(true);
      return createRunResult("final");
    });

    try {
      const result = await execute({ opts: { onAgentRunStart }, replyOperation, typingSignals });

      expect(result.kind).toBe("success");
      expect(typingSignals.signalExecutionActivity).toHaveBeenCalledOnce();
      expect(typingSignals.signalRunStart).not.toHaveBeenCalled();
      expect(onAgentRunStart).toHaveBeenCalledOnce();
    } finally {
      replyOperation.complete();
    }
  });

  it.each([
    { backend: "embedded", provider: "anthropic", model: "claude", text: "HEARTBEAT_OK" },
    { backend: "CLI", provider: "claude-cli", model: "sonnet-4.6", text: "final" },
  ])(
    "forwards the event queue and bundle MCP retirement to isolated heartbeat $backend runs",
    async ({ backend, provider, model, text }) => {
      const isCli = backend === "CLI";
      state.isCliProviderMock.mockReturnValue(isCli);
      state.runWithModelFallbackMock.mockImplementationOnce((params: FallbackRunnerParams) =>
        runFallbackCandidate(params, provider, model),
      );
      const run = isCli ? state.runCliAgentMock : state.runEmbeddedAgentMock;
      run.mockResolvedValueOnce(createRunResult(text));
      const followupRun = createFollowupRun({ provider, model });
      const opts = withReplySystemEventContext<InternalGetReplyOptions>(
        { isHeartbeat: true, cleanupBundleMcpOnRunEnd: true },
        {
          sessionKey: "agent:main:heartbeat:heartbeat",
          heartbeatEventQueueSessionKey: "agent:main:heartbeat",
        },
      );
      const params = createMinimalRunAgentTurnParams({ followupRun, opts });
      params.isHeartbeat = true;
      await executeAgentTurn(params);
      expectMockCallArgFields(run, 0, "isolated heartbeat run params", {
        trigger: "heartbeat",
        requireExplicitMessageTarget: true,
        heartbeatEventQueueSessionKey: "agent:main:heartbeat",
        cleanupBundleMcpOnRunEnd: true,
      });
    },
  );

  it("omits requireExplicitMessageTarget on ordinary embedded runs", async () => {
    state.runWithModelFallbackMock.mockImplementationOnce((params: FallbackRunnerParams) =>
      runFallbackCandidate(params, "anthropic", "claude"),
    );
    state.runEmbeddedAgentMock.mockResolvedValueOnce(createRunResult("ok"));

    await execute();

    const embeddedParams = requireMockCall(
      state.runEmbeddedAgentMock,
      0,
      "ordinary embedded run params",
    )[0] as Record<string, unknown>;
    expect(embeddedParams).not.toHaveProperty("requireExplicitMessageTarget");
  });

  it("registers run ownership before asynchronous image preflight", async () => {
    const agentRunRegistry = await import("../../infra/agent-run-registry.js");
    const registerAgentRunContext = vi.mocked(agentRunRegistry.registerAgentRunContext);
    const imagesStarted = createDeferred();
    const releaseImages = createDeferred();
    state.resolveCurrentTurnImagesMock.mockImplementationOnce(async () => {
      imagesStarted.resolve();
      await releaseImages.promise;
      return {};
    });
    state.runEmbeddedAgentMock.mockResolvedValueOnce(createRunResult("ok"));

    const runPromise = execute();

    try {
      await awaitGateBeforeSettlement(
        imagesStarted.promise,
        runPromise,
        "image preflight did not start",
      );
      expect(registerAgentRunContext).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          sessionKey: "main",
          sessionId: "session",
        }),
      );
      expect(state.runWithModelFallbackMock).not.toHaveBeenCalled();
    } finally {
      releaseImages.resolve();
      await runPromise;
    }
  });

  it("does not consume channel evidence until a retry reaches runtime admission", async () => {
    const captured: unknown[] = [];
    const audit = createChannelAdmissionAudit({ enabled: true });
    const clearSink = configureExecutionIdentityAdmissionSink((work) => {
      captured.push(work);
      return true;
    });
    try {
      const followupRun = createFollowupRun();
      followupRun.run.config = { logging: { audit: { executionIdentity: true } } };
      followupRun.channelAdmissionEvidence = createChannelParticipantAdmissionEvidence({
        audit,
        channelId: "whatsapp",
        participantId: "person-1",
      });
      state.resolveCurrentTurnImagesMock.mockRejectedValueOnce(new Error("invalid image metadata"));

      await expect(execute({ followupRun, opts: { runId: "preflight-failure" } })).rejects.toThrow(
        "invalid image metadata",
      );
      expect(captured).toEqual([]);

      state.runEmbeddedAgentMock.mockImplementationOnce(admitEmbeddedRun);
      await execute({ followupRun, opts: { runId: "preflight-success" } });

      expect(captured).toHaveLength(1);
      expect(captured).toMatchObject([
        {
          kind: "capture",
          envelope: { ingress: { state: "present" }, invoker: { state: "present" } },
        },
      ]);
    } finally {
      clearSink();
      audit.close();
    }
  });

  it("passes runtime toolsAllow to embedded agent runs", async () => {
    state.runEmbeddedAgentMock.mockResolvedValueOnce(createRunResult("ok"));

    await execute({ opts: { toolsAllow: ["message"] } });

    expectMockCallArgFields(state.runEmbeddedAgentMock, 0, "embedded run params", {
      toolsAllow: ["message"],
    });
  });
});
