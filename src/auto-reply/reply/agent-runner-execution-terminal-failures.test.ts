import { assert, expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../../test/helpers/promise.js";
import { createCliTimeoutError } from "../../agents/cli-runner/no-output-timeout-policy.js";
import { buildPayloads } from "../../agents/embedded-agent-runner/run/payloads.test-helpers.js";
import { FailoverError } from "../../agents/failover-error.js";
import { formatBillingErrorMessage } from "../../agents/failover/user-copy.js";
import {
  MISSING_REPLY_NOTICE_TEXT,
  MISSING_REPLY_SIDE_EFFECT_NOTICE_TEXT,
} from "../../agents/reply-completion.js";
import {
  createAgentRunDirectAbortError,
  createAgentRunRestartAbortError,
} from "../../agents/run-termination.js";
import { makeAssistantMessageFixture } from "../../agents/test-helpers/assistant-message-fixtures.js";
import { deriveGatewaySessionLifecycleProjectionPatch } from "../../gateway/session-lifecycle-state.js";
import { GatewayDrainingError } from "../../process/command-queue.js";
import {
  markGatewayRestartDraining,
  resetGatewayWorkAdmission,
} from "../../process/gateway-work-admission.js";
import { createReplyOperation } from "../../sessions/session-controller.js";
import { WorkerNodeLostError } from "../../worker/worker-node-loss.js";
import { getReplyPayloadMetadata } from "../reply-payload.js";
import { setupExecutionSuite } from "./agent-runner-execution-suite.test-support.js";
import {
  createRunResult,
  GENERIC_RUN_FAILURE_TEXT,
  createRunAgentTurnParams,
  createFollowupRun,
  createMockReplyOperation,
  requireMockCall,
  createMinimalRunAgentTurnParams,
  createTestFallbackSummaryError,
  type EmbeddedAgentParams,
} from "./agent-runner-execution.test-support.js";
import { buildKnownAgentRunFailureReplyPayload } from "./agent-runner-failure-reply.js";
import {
  REPLY_OPERATION_RUN_STATE,
  type ReplyOperationRunState,
} from "./reply-operation-run-state.js";

const { state, runTurn, runRawTurn, terminalEvents } = await setupExecutionSuite();

function runningOperation(name: string, sessionId = name, upstreamAbortSignal?: AbortSignal) {
  const operation = createReplyOperation({
    sessionKey: `agent:main:${name}`,
    sessionId,
    resetTriggered: false,
    upstreamAbortSignal,
  });
  operation.setPhase("running");
  return operation;
}

function exhausted(cause: Error, error: string) {
  return createTestFallbackSummaryError({
    message: "fallback exhausted",
    soonestCooldownExpiry: null,
    cause,
    attempts: [{ provider: "anthropic", model: "claude", error, reason: "unknown" }],
  });
}

async function finalPayload(params: Parameters<typeof runTurn>[0] = {}) {
  const result = await runTurn(params);
  assert(result.kind === "final");
  return result.payload;
}

it.each([
  { message: MISSING_REPLY_NOTICE_TEXT, expected: MISSING_REPLY_NOTICE_TEXT },
  {
    message: MISSING_REPLY_SIDE_EFFECT_NOTICE_TEXT,
    expected: MISSING_REPLY_SIDE_EFFECT_NOTICE_TEXT,
  },
  { message: "private provider detail", expected: "Agent run failed" },
])(
  "egresses only host missing-reply copy from an incomplete turn",
  async ({ message, expected }) => {
    state.runWithModelFallbackMock.mockResolvedValueOnce({
      result: {
        payloads: [],
        meta: {
          error: { kind: "incomplete_turn", message, fallbackSafe: false },
          terminalReply: { disposition: "empty" },
          terminalReplyExpectation: "result-required",
        },
      },
      provider: "openai",
      model: "test-model",
      attempts: [],
    });

    const result = await runRawTurn(createRunAgentTurnParams(createFollowupRun()));

    expect(terminalEvents(result.runId)).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({ phase: "error", error: expected }),
      }),
    ]);
  },
);

it("preserves disabled retry exhaustion through returned provider payloads", async () => {
  const rawError = "429 rate limit exceeded. Please try again in 221ms.";
  const payloads = buildPayloads({
    provider: "external",
    lastAssistant: makeAssistantMessageFixture({
      provider: "external",
      model: "primary",
      errorMessage: rawError,
    }),
    rateLimitRetriesExhausted: 0,
  });
  expect(getReplyPayloadMetadata(payloads[0]!)?.providerFailure).toMatchObject({
    rawError,
    rateLimitRetriesExhausted: 0,
  });
  state.runWithModelFallbackMock.mockResolvedValueOnce({
    result: {
      payloads,
      meta: {
        replayInvalid: true,
        error: { kind: "incomplete_turn", message: rawError, fallbackSafe: false },
      },
    },
    provider: "external",
    model: "primary",
    attempts: [],
  });
  const result = await runTurn(createRunAgentTurnParams(createFollowupRun()));
  const text = JSON.stringify(result);
  expect(text).toContain("recovery is disabled");
  assert(result.kind === "success");
  expect(result.runResult.payloads?.[0]?.text).not.toContain("221ms");
});

it("preserves retry exhaustion through external thrown failures", async () => {
  const rawError = "HTTP 429: An error occurred while processing your request. Try again in 221ms.";
  state.runWithModelFallbackMock.mockRejectedValueOnce(
    new FailoverError(rawError, {
      rawError,
      status: 429,
      reason: "rate_limit",
      rateLimitRetriesExhausted: 9,
    }),
  );
  const payload = await finalPayload({
    ...createRunAgentTurnParams(createFollowupRun()),
    sessionCtx: { Provider: "whatsapp", MessageSid: "message" },
  });
  expect(payload.text).toContain("9 automatic retries");
});

it("surfaces billing guidance for mixed-cause fallback exhaustion", async () => {
  state.runWithModelFallbackMock.mockRejectedValueOnce(
    createTestFallbackSummaryError({
      message:
        "All models failed (2): anthropic/claude: 429 (rate_limit) | openai/gpt-5.4: 402 (billing)",
      attempts: [
        { provider: "anthropic", model: "claude", error: "429", reason: "rate_limit" },
        { provider: "openai", model: "gpt-5.4", error: "402", reason: "billing" },
      ],
      soonestCooldownExpiry: Date.now() + 60_000,
    }),
  );

  const payload = await finalPayload(createRunAgentTurnParams(createFollowupRun()));

  expect(payload.text).toBe(formatBillingErrorMessage());
  expect(payload.text).not.toContain("All models failed");
  expect(payload.text).not.toContain("402 (billing)");
  expect(payload.text).not.toContain("Rate-limited");
});

it("keeps the provider reset hint when the chain summary exceeds the length guard", async () => {
  // Ordinary provider text must survive the length guard that rejects raw HTML/JSON.
  const hint = "You've hit your session limit \u00b7 resets 6:20pm (Europe/London)";
  const message =
    `All models failed (3): anthropic/claude-opus-5: ${hint} (unknown) | ` +
    `claude-cli/claude-sonnet-5: ${hint} (unknown) | ` +
    "openai/gpt-5.6-sol: Codex error: The usage limit has been reached (rate_limit)";
  expect(message.length).toBeGreaterThan(300);
  state.runWithModelFallbackMock.mockResolvedValueOnce({
    result: { payloads: [], meta: { error: new Error(message) } },
    provider: "anthropic",
    model: "claude-opus-5",
    attempts: [],
  });

  const result = await runTurn(createRunAgentTurnParams(createFollowupRun()));

  const rendered = JSON.stringify(result);
  expect(rendered).toContain("resets 6:20pm (Europe/London)");
  expect(rendered).not.toContain("API rate limit reached. Please try again later.");
});

it("surfaces restart text when fallback exhaustion wraps a drain error, keeping fail bookkeeping", async () => {
  const { replyOperation, failMock } = createMockReplyOperation();
  state.runWithModelFallbackMock.mockRejectedValueOnce(
    exhausted(new GatewayDrainingError(), "gateway draining"),
  );

  const payload = await finalPayload({
    ...createRunAgentTurnParams(createFollowupRun()),
    replyOperation,
    opts: {},
  });

  expect(payload.text).toBe("⚠️ Gateway is restarting. Please wait a few seconds and try again.");
  const failCall = requireMockCall(failMock, 0, "reply operation fail");
  expect(failCall[0]).toBe("gateway_draining");
  expect(failCall[1]).toBeInstanceOf(GatewayDrainingError);
});

it("preserves controller restart cancellation when fallback exhaustion wraps its abort", async () => {
  const replyOperation = runningOperation("wrapped-restart-abort");
  const failMock = vi.spyOn(replyOperation, "fail");
  state.runWithModelFallbackMock.mockImplementationOnce(async () => {
    const reason = createAgentRunRestartAbortError();
    expect(replyOperation.abortForRestart()).toBe(true);
    throw exhausted(reason, "agent run aborted for restart");
  });

  try {
    const result = await runRawTurn({ replyOperation });
    expect(result.outcome).toEqual({ kind: "aborted", reason: "restart" });
    expect(replyOperation.result).toEqual({ kind: "aborted", code: "aborted_for_restart" });
    expect(failMock).not.toHaveBeenCalled();
  } finally {
    replyOperation.complete();
  }
});

it("retains automatic recovery when restart admission refuses an active turn", async () => {
  const replyOperation = runningOperation("restart-refusal");
  state.runEmbeddedAgentMock.mockImplementationOnce(async (params: EmbeddedAgentParams) => {
    await params.onAgentEvent?.({ stream: "lifecycle", data: { phase: "start" } });
    params.onExecutionPhase?.({
      phase: "model_call_started",
      provider: "openai",
      model: "fixture",
    });
    // The admission fence closes before the shutdown owner aborts the turn.
    markGatewayRestartDraining();
    throw new GatewayDrainingError();
  });
  try {
    const result = await runRawTurn({ replyOperation });
    expect(result.outcome).toEqual({ kind: "aborted", reason: "restart" });
    expect(replyOperation.result).toEqual({ kind: "aborted", code: "aborted_for_restart" });
    const terminals = terminalEvents(result.runId);
    expect(terminals).toHaveLength(1);
    expect(terminals[0]?.data).toMatchObject({
      phase: "end",
      aborted: true,
      stopReason: "restart",
    });
    expect(
      deriveGatewaySessionLifecycleProjectionPatch({
        entry: { updatedAt: 1, startedAt: 1 },
        event: { ...terminals[0]!, ts: 2 },
      }),
    ).toMatchObject({ status: "interrupted", abortedLastRun: true });
  } finally {
    resetGatewayWorkAdmission();
    replyOperation.complete();
  }
});

it.each([
  { label: "reconnected first interruption", continuing: true },
  { label: "second interruption", continuing: false },
])("settles $label through the node-loss continuation owner", async ({ continuing }) => {
  const replyOperation = runningOperation("node-loss-terminal", "session");
  const loss = new WorkerNodeLostError();
  loss.canContinue = true;
  state.runEmbeddedAgentMock.mockRejectedValueOnce(loss);
  const continueStalledTurn = vi.fn(() => continuing);
  const runState: ReplyOperationRunState = {
    continueStalledTurn,
    // The queued continuation retains the original invocation's options.
    ...(!continuing
      ? { replyCompletion: { expectation: "required" as const, outcome: "pending" as const } }
      : {}),
  };
  const onAgentRunTerminalOutcome = vi.fn();
  const params = createMinimalRunAgentTurnParams({ replyOperation });
  params.opts = { [REPLY_OPERATION_RUN_STATE]: runState, onAgentRunTerminalOutcome };
  try {
    const result = await runRawTurn(params);
    expect(result.outcome).toMatchObject({
      kind: "rejected",
      payload: {
        text: continuing ? "" : `${loss.message} This turn will not be continued automatically.`,
      },
    });
    expect(state.runEmbeddedAgentMock).toHaveBeenCalledOnce();
    if (continuing) {
      expect(runState.replyCompletion?.outcome).toBe("pending");
      expect(replyOperation.result).toBeNull();
      expect(onAgentRunTerminalOutcome).not.toHaveBeenCalled();
    } else {
      expect(replyOperation.result).toMatchObject({ kind: "failed", code: "run_failed" });
      expect(onAgentRunTerminalOutcome).toHaveBeenCalledExactlyOnceWith("failed");
    }
    expect(continueStalledTurn).toHaveBeenCalledExactlyOnceWith(expect.any(String), replyOperation);
    const terminals = terminalEvents(result.runId);
    expect(terminals).toHaveLength(1);
    expect(terminals[0]?.data).toMatchObject(
      continuing
        ? { phase: "end", yielded: true, terminalReply: { disposition: "empty" } }
        : { phase: "error" },
    );
  } finally {
    replyOperation.complete();
  }
});

it.each([
  { reason: "restart", code: "aborted_for_restart", phase: "end", stopReason: "restart" },
  {
    reason: "restart",
    code: "aborted_for_restart",
    phase: "end",
    stopReason: "restart",
    backendOwned: true,
    restartError: true,
  },
  {
    reason: "superseded",
    code: "aborted_for_supersession",
    phase: "error",
    stopReason: "superseded",
  },
] as const)(
  "records one $stopReason abort terminal event without returning a reply ($restartError)",
  async (testCase) => {
    const { reason, code, phase, stopReason } = testCase;
    const upstreamAbort = new AbortController();
    const replyOperation = runningOperation("abort-terminal", "session", upstreamAbort.signal);
    const failMock = vi.spyOn(replyOperation, "fail");
    state.runEmbeddedAgentMock.mockImplementationOnce(async () => {
      if (reason === "superseded") {
        replyOperation.supersede();
      } else if (!("backendOwned" in testCase)) {
        upstreamAbort.abort(createAgentRunRestartAbortError());
      }
      if ("restartError" in testCase) {
        throw createAgentRunRestartAbortError();
      }
      throw Object.assign(new Error("aborted"), { name: "AbortError" });
    });

    try {
      const result = await runRawTurn({
        replyOperation,
        opts: { abortSignal: upstreamAbort.signal },
        isRestartRecoveryArmed: async () => true,
      });

      expect(result.outcome).toEqual({ kind: "aborted", reason });
      expect(replyOperation.result).toEqual({ kind: "aborted", code });
      expect(failMock).not.toHaveBeenCalled();
      expect(state.runEmbeddedAgentMock).toHaveBeenCalledOnce();
      const terminals = terminalEvents(result.runId);
      expect(terminals).toHaveLength(1);
      expect(terminals[0]?.data).toMatchObject({ phase, aborted: true, stopReason });
    } finally {
      replyOperation.complete();
      failMock.mockRestore();
    }
  },
);

it.for([false, true])(
  "preserves the prior terminal row when cancellation precedes execution (started=%s)",
  async (started, { signal }) => {
    const reachedBoundary = createDeferred();
    const release = createDeferred();
    const upstreamAbort = new AbortController();
    const replyOperation = createReplyOperation({
      sessionKey: "agent:main:cancel-boundary",
      sessionId: "cancel-boundary",
      resetTriggered: false,
      upstreamAbortSignal: upstreamAbort.signal,
    });
    state.runEmbeddedAgentMock.mockImplementationOnce(async (params: EmbeddedAgentParams) => {
      if (started) {
        await params.onAgentEvent?.({ stream: "lifecycle", data: { phase: "start" } });
        params.onExecutionPhase?.({
          phase: "model_call_started",
          provider: "openai",
          model: "gpt-5.4",
        });
      }
      reachedBoundary.resolve();
      await release.promise;
      upstreamAbort.signal.throwIfAborted();
      throw new Error("Cancellation must stop this candidate");
    });
    const pending = runRawTurn({ replyOperation, opts: { abortSignal: upstreamAbort.signal } });
    try {
      await withinTest(
        awaitGateBeforeSettlement(
          reachedBoundary.promise,
          pending,
          "Candidate never reached cancellation boundary",
        ),
        signal,
      );
      upstreamAbort.abort(createAgentRunDirectAbortError());
      release.resolve();
      const result = await pending;
      expect(result.outcome).toMatchObject({ kind: "aborted", reason: "user" });
      const terminals = terminalEvents(result.runId).filter(
        (event) => event.data.phase === "error",
      );
      expect(terminals).toHaveLength(1);
      const terminal = terminals[0]!;
      const patch = deriveGatewaySessionLifecycleProjectionPatch({
        entry: {
          updatedAt: 2,
          startedAt: 1,
          endedAt: 2,
          lastRunId: "prior-completed-run",
          lastRunError: "prior timeout",
        },
        event: { ...terminal, ts: 3 },
      });
      if (started) {
        expect(terminal.data.executionStarted).not.toBe(false);
        expect(patch).toMatchObject({ status: "killed", abortedLastRun: true });
      } else {
        expect(patch).toEqual({});
        expect(terminal.data).toMatchObject({ executionStarted: false, providerStarted: false });
      }
    } finally {
      release.resolve();
      await pending.catch(() => undefined);
      replyOperation.complete();
    }
  },
);

it("settles a completed result after awaiting restart recovery", async () => {
  const result = createRunResult("completed before the restart marker was observed");
  const runId = "armed-restart-settled-result";
  const { replyOperation, failMock } = createMockReplyOperation();
  let operationResult: typeof replyOperation.result = null;
  const abortForRestart = vi.fn(() => {
    operationResult = { kind: "aborted", code: "aborted_for_restart" };
    return true;
  });
  const complete = vi.fn(() => {
    operationResult ??= { kind: "completed" };
  });
  const restartReplyOperation = {
    ...replyOperation,
    get result() {
      return operationResult;
    },
    abortForRestart,
    complete,
  } satisfies typeof replyOperation;
  state.runEmbeddedAgentMock.mockResolvedValueOnce(result);

  const execution = await runRawTurn({
    replyOperation: restartReplyOperation,
    opts: { runId },
    isRestartRecoveryArmed: async () => true,
  });

  expect(execution).toEqual({
    runId,
    outcome: { kind: "aborted", reason: "restart" },
  });
  expect(abortForRestart).toHaveBeenCalledOnce();
  expect(complete).not.toHaveBeenCalled();
  expect(restartReplyOperation.result).toEqual({ kind: "aborted", code: "aborted_for_restart" });
  expect(failMock).not.toHaveBeenCalled();
});

it("surfaces CLI max-turn recovery context at normal verbosity", async () => {
  const recoveryText =
    "Claude CLI stopped after reaching the maximum number of turns (limit: 1). " +
    "OpenClaw run: run-max-turns. OpenClaw session: session-1. Claude session: claude-session-1. " +
    "Tool actions may already have run; verify their effects before retrying. " +
    "Retry with a higher --max-turns value or a narrower task.";
  const terminalStop = new FailoverError(recoveryText, {
    reason: "unknown",
    code: "cli_max_turns",
    provider: "claude-cli",
    model: "sonnet",
  });
  state.runEmbeddedAgentMock.mockRejectedValueOnce(
    new AggregateError(
      [terminalStop, new Error("fork successor persistence failed")],
      "CLI turn failed and its fork successor could not be persisted",
    ),
  );

  const payload = await finalPayload();

  expect(payload).toMatchObject({ isError: true, text: recoveryText });
  expect(payload.text).not.toBe(GENERIC_RUN_FAILURE_TEXT);
});

it("warns that interrupted CLI background work may have completed", () => {
  const payload = buildKnownAgentRunFailureReplyPayload({
    err: createCliTimeoutError(
      { provider: "claude-cli" },
      {
        mode: "overall",
        timeoutSeconds: 600,
        observedActivity: true,
        activeToolCount: 1,
        backgroundTaskCount: 1,
      },
      "cli_overall_timeout",
    ),
    sessionCtx: createMinimalRunAgentTurnParams().sessionCtx,
    resolvedVerboseLevel: "off",
  });

  expect(payload?.text).toContain("Some work may have completed");
  expect(payload?.text).toContain("Check its results before trying again");
  expect(payload?.text).toContain("task time limit in the Control UI settings");
});

it("surfaces Codex app-server bridge failures instead of generic copy", async () => {
  state.runWithModelFallbackMock.mockRejectedValueOnce(
    new Error("codex app-server turn idle timed out waiting for turn/completed"),
  );

  const payload = await finalPayload({});

  expect(payload.text).not.toBe(GENERIC_RUN_FAILURE_TEXT);
  expect(payload.text).toContain("may still be running");
  expect(payload.text).toContain("hasn't confirmed whether the task finished");
});

it("forwards sanitized generic errors on external chat channels when verbose is on", async () => {
  state.runEmbeddedAgentMock.mockRejectedValueOnce(
    new Error("INVALID_ARGUMENT: some other failure"),
  );

  const payload = await finalPayload({
    ...createRunAgentTurnParams(createFollowupRun()),
    opts: {},
    resolvedVerboseLevel: "on",
  });

  expect(payload.text).toBe(
    "⚠️ Agent failed before reply: INVALID_ARGUMENT: some other failure. Please try again, or use /new to start a fresh session.",
  );
});
