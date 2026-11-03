import { expectDefined } from "@openclaw/normalization-core/expect";
import { assert, expect, it, vi } from "vitest";
import { GENERIC_EXTERNAL_RUN_FAILURE_TEXT } from "../../agents/failover/user-copy.js";
import { getReplyPayloadMetadata, setReplyPayloadMetadata } from "../reply-payload.js";
import type { GetReplyOptions } from "../types.js";
import { setupExecutionSuite } from "./agent-runner-execution-suite.test-support.js";
import {
  createRunAgentTurnParams,
  getRawExecuteAgentTurnForTest,
  createFollowupRun,
  initialFallbackAttemptOptions,
  requireRecord,
  expectRecordFields,
  createMinimalRunAgentTurnParams,
  createNonDirectFailureSessionCtx,
} from "./agent-runner-execution.test-support.js";
import type {
  FallbackRunnerParams,
  EmbeddedAgentParams,
} from "./agent-runner-execution.test-support.js";
import { accountAgentTurn } from "./agent-runner-result-accounting.js";
import { resolveFollowupDeliveryDecision } from "./followup-delivery.js";
import { createTurn } from "./followup-delivery.test-helpers.js";
import { createReplyDispatcher } from "./reply-dispatcher.js";
const { state, runTurn } = await setupExecutionSuite();

function primaryRun() {
  const followupRun = createFollowupRun();
  Object.assign(followupRun.run, { provider: "openai", model: "gpt-5.4" });
  return followupRun;
}

async function deliverToolResults(onToolResult: GetReplyOptions["onToolResult"]) {
  const input = createRunAgentTurnParams(createFollowupRun());
  input.opts = { onToolResult };
  const result = await runTurn(input);
  await Promise.all(input.pendingToolTasks);
  return { result, typingSignals: input.typingSignals };
}

async function classifyPrimary(params: FallbackRunnerParams) {
  const result = requireRecord(
    await params.run("openai", "gpt-5.4", initialFallbackAttemptOptions(params)),
    "executed fallback result",
  );
  const classification = await params.classifyResult?.({
    result,
    provider: "openai",
    model: "gpt-5.4",
    attempt: 1,
    total: 2,
  });
  return { result, classification };
}

it.each([
  { stopReason: "error", failureText: GENERIC_EXTERNAL_RUN_FAILURE_TEXT },
  { stopReason: "superseded", failureText: undefined },
])("preserves canonical $stopReason after private partial output", async (testCase) => {
  const followupRun = createFollowupRun();
  followupRun.run.sourceReplyDeliveryMode = "message_tool_only";
  state.runEmbeddedAgentMock.mockResolvedValueOnce({
    payloads: [{ text: "Private partial output before the run ended." }],
    meta: { stopReason: testCase.stopReason },
  });

  const result = await runTurn({ followupRun });

  assert(result.kind === "success");
  expect(result.terminalFailurePayload?.text).toBe(testCase.failureText);
  if (testCase.failureText !== undefined) {
    assert(result.terminalFailurePayload);
    expect(result.terminalFailurePayload.isError).toBe(true);
    expect(
      getReplyPayloadMetadata(result.terminalFailurePayload)?.deliverDespiteSourceReplySuppression,
    ).toBe(true);
  }
});

it.each(["missing-answer", "blocked-tool"])(
  "preserves one %s notice through queued delivery",
  async (kind) => {
    const followupRun = createFollowupRun();
    followupRun.originatingChannel = "whatsapp";
    followupRun.originatingTo = "user";
    if (kind === "missing-answer") {
      followupRun.run.sourceReplyDeliveryMode = "message_tool_only";
    }
    followupRun.run.terminalReplyExpectation = "required";
    const notice =
      kind === "missing-answer"
        ? setReplyPayloadMetadata(
            {
              text: "No answer was returned. Ask again if you still need one.",
              isError: true,
              isStatusNotice: true,
            },
            { assistantTranscriptOwned: true },
          )
        : { text: "⚠️ Bash blocked", isError: true };
    state.runEmbeddedAgentMock.mockResolvedValueOnce({
      payloads: [notice],
      meta: {
        error: {
          kind: "incomplete_turn",
          message: notice.text,
        },
      },
    });
    const params = createMinimalRunAgentTurnParams({ followupRun });
    const execute = await getRawExecuteAgentTurnForTest();
    const execution = await execute(params);
    assert(execution.outcome.kind === "settled");
    expect(execution.outcome.status).toBe("failed");
    expect(execution.outcome.result.payloads).toEqual(kind === "missing-answer" ? [] : [notice]);
    if (kind === "missing-answer") {
      expect(execution.outcome.terminalFailurePayload).toBe(notice);
    }

    const accounting = await accountAgentTurn({
      activeSessionEntry: undefined,
      activeSessionStore: undefined,
      blockReplyPipeline: null,
      cfg: followupRun.run.config,
      defaultModel: followupRun.run.model,
      followupRun,
      pendingToolTasks: params.pendingToolTasks,
      preflightCompactionApplied: false,
      resolvedVerboseLevel: "off",
      execution: execution.outcome,
      runId: execution.runId,
      runStartedAt: 0,
      sessionCtx: params.sessionCtx,
      sessionKey: undefined,
      storePath: undefined,
      shouldInjectGroupIntro: false,
    });
    const turn = createTurn({ runId: execution.runId, queued: followupRun });
    const decision = await resolveFollowupDeliveryDecision({ turn, execution, accounting });
    assert(decision.kind === "deliver");
    expect(decision.payloads).toHaveLength(1);
    expect(decision.payloads[0]).toMatchObject(notice);
    if (kind === "missing-answer") {
      expect(
        getReplyPayloadMetadata(expectDefined(decision.payloads[0], "missing-answer notice")),
      ).toMatchObject({
        assistantTranscriptOwned: true,
        deliverDespiteSourceReplySuppression: true,
      });
    }
    const deliver = vi.fn(async () => {});
    const dispatcher = createReplyDispatcher({ deliver });
    dispatcher.sendFinalReply(expectDefined(decision.payloads[0], "terminal notice"));
    dispatcher.markComplete();
    await dispatcher.waitForIdle();
    expect(deliver).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ text: notice.text, isError: true }),
      { kind: "final" },
    );
  },
);

it.each([{ mediaUrls: ["/tmp/generated.png"] }, { text: "NO_REPLYThe user is saying hello" }])(
  "forwards tool results without losing literal text or media: %j",
  async (payload) => {
    const onToolResult = vi.fn();
    state.runEmbeddedAgentMock.mockImplementationOnce(async (params: EmbeddedAgentParams) => {
      await params.onToolResult?.(payload);
      return { payloads: [{ text: "final" }], meta: {} };
    });

    const { result, typingSignals } = await deliverToolResults(onToolResult);

    expect(result.kind).toBe("success");
    expect(onToolResult).toHaveBeenCalledOnce();
    if (payload.text) {
      expect(typingSignals.signalTextDelta).toHaveBeenCalledWith(payload.text);
      expect(onToolResult).toHaveBeenCalledWith(payload);
    } else {
      expect(typingSignals.signalTextDelta).not.toHaveBeenCalled();
      expect(onToolResult.mock.calls[0]?.[0]).toMatchObject(payload);
      expect(onToolResult.mock.calls[0]?.[0].text).toBeUndefined();
    }
  },
);

it("surfaces model capacity errors from no-text mid-turn failures in Slack channels", async () => {
  state.runEmbeddedAgentMock.mockResolvedValueOnce({
    payloads: [{ text: "thinking", isReasoning: true }],
    meta: {
      error: {
        kind: "server_overloaded",
        message: "Selected model is at capacity. Please try a different model.",
      },
    },
  });

  const result = await runTurn({
    sessionCtx: createNonDirectFailureSessionCtx({
      label: "Slack channel",
      provider: "slack",
      chatType: "channel",
    }),
  });

  assert(result.kind === "success");
  expect(result.runResult.payloads).toEqual([
    {
      text: "⚠️ Selected model is at capacity. Try a different model, or wait and retry.",
      isError: true,
    },
  ]);
});

it("classifies structured harness plan-only terminal results as fallback-eligible", async () => {
  const followupRun = primaryRun();
  state.runEmbeddedAgentMock.mockResolvedValueOnce({
    payloads: [],
    meta: { agentHarnessResultClassification: "planning-only" },
  });
  state.runWithModelFallbackMock.mockImplementationOnce(async (params: FallbackRunnerParams) => {
    const { classification } = await classifyPrimary(params);
    expectRecordFields(requireRecord(classification, "fallback classification"), {
      reason: "format",
      code: "planning_only_result",
    });
    return {
      result: { payloads: [{ text: "fallback ok" }], meta: {} },
      provider: "anthropic",
      model: "claude",
      attempts: [
        { provider: "openai", model: "gpt-5.4", error: "planning-only", reason: "format" },
      ],
    };
  });

  const result = await runTurn({ followupRun });

  assert(result.kind === "success");
  expect(result.runResult.payloads?.[0]?.text).toBe("fallback ok");
  expect(result.fallbackProvider).toBe("anthropic");
  expect(result.fallbackAttempts[0]?.reason).toBe("format");
});

it.each(["sent", "buffered"] as const)(
  "does not classify empty final payloads with %s block replies",
  async (deliveryState) => {
    const followupRun = primaryRun();
    const blockReplyPipeline =
      deliveryState === "buffered"
        ? {
            enqueue: vi.fn(),
            flush: vi.fn(async () => {}),
            stop: vi.fn(),
            hasBuffered: vi.fn(() => true),
            didStream: vi.fn(() => false),
            isAborted: vi.fn(() => false),
            hasSentPayload: vi.fn(() => false),
            hasRetryBlockedDelivery: () => false,
            getSentMediaUrls: vi.fn(() => []),
          }
        : null;
    if (deliveryState === "sent") {
      const delivery =
        await vi.importActual<typeof import("./reply-delivery.js")>("./reply-delivery.js");
      state.createBlockReplyDeliveryHandlerMock.mockImplementationOnce(
        delivery.createBlockReplyDeliveryHandler,
      );
      state.runEmbeddedAgentMock.mockImplementationOnce(async (params: EmbeddedAgentParams) => {
        await params.onBlockReply?.({ text: "streamed block" });
        return { payloads: [], meta: {} };
      });
    } else {
      state.runEmbeddedAgentMock.mockResolvedValueOnce({ payloads: [], meta: {} });
    }
    state.runWithModelFallbackMock.mockImplementationOnce(async (params: FallbackRunnerParams) => {
      const { result, classification } = await classifyPrimary(params);
      expect(classification).toBeUndefined();
      return { result, provider: "openai", model: "gpt-5.4", attempts: [] };
    });

    const result = await runTurn({
      followupRun,
      blockReplyPipeline,
      blockStreamingEnabled: true,
      opts: { onBlockReply: vi.fn() },
    });

    expect(result.kind).toBe("success");
  },
);

it("propagates rejected approval notice delivery while preserving later best-effort results", async () => {
  const payload = {
    text: "Exec approval is required, but no interactive approval client is currently available.",
  };
  const delivered: string[] = [];
  const onToolResult = vi.fn(async (result: { text?: string }) => {
    if (result.text !== "later") {
      throw new Error("delivery failed");
    }
    delivered.push(result.text);
  });
  state.runEmbeddedAgentMock.mockImplementationOnce(async (params: EmbeddedAgentParams) => {
    await expect(params.onToolResult?.(payload)).rejects.toThrow("delivery failed");
    await expect(params.onToolResult?.({ text: "later" })).resolves.toBeUndefined();
    return { payloads: [{ text: "final" }], meta: {} };
  });

  const input = createMinimalRunAgentTurnParams({ opts: { onToolResult } });
  const result = await runTurn(input);
  await Promise.all(input.pendingToolTasks);

  expect(result.kind).toBe("success");
  expect(delivered).toEqual(["later"]);
});

it("delivers streamed tool results in callback order even when dispatch latency differs", async () => {
  const deliveryOrder: string[] = [];
  const onToolResult = vi.fn(async (payload: { text?: string }) => {
    const delay = payload.text === "first" ? 5 : 1;
    await new Promise((resolve) => {
      setTimeout(resolve, delay);
    });
    deliveryOrder.push(payload.text ?? "");
  });
  state.runEmbeddedAgentMock.mockImplementationOnce(async (params: EmbeddedAgentParams) => {
    void params.onToolResult?.({ text: "first", mediaUrls: [] });
    void params.onToolResult?.({ text: "second", mediaUrls: [] });
    return { payloads: [{ text: "final" }], meta: {} };
  });

  const { result } = await deliverToolResults(onToolResult);

  expect(result.kind).toBe("success");
  expect(onToolResult).toHaveBeenCalledTimes(2);
  expect(deliveryOrder).toEqual(["first", "second"]);
});
