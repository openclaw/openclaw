import { describe, expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../../test/helpers/promise.js";
import { createCliTimeoutError } from "../../agents/cli-runner/no-output-timeout-policy.js";
import { FailoverError } from "../../agents/failover-error.js";
import {
  formatBillingErrorMessage,
  HEARTBEAT_EXTERNAL_RUN_FAILURE_TEXT,
  renderHeartbeatRunFailureCopy,
} from "../../agents/failover/user-copy.js";
import {
  AgentHarnessPreflightError,
  AgentHarnessSessionSupersededError,
} from "../../agents/harness/errors.js";
import {
  createAgentRunDirectAbortError,
  createAgentRunRestartAbortError,
  createAgentRunSupersededAbortError,
  createSessionPlacementSettlementClosedAbortError,
} from "../../agents/run-termination.js";
import { deriveGatewaySessionLifecycleProjectionPatch } from "../../gateway/session-lifecycle-state.js";
import { CommandLaneClearedError, GatewayDrainingError } from "../../process/command-queue.js";
import type { TemplateContext } from "../templating.js";
import { SILENT_REPLY_TOKEN } from "../tokens.js";
import type { GetReplyOptions } from "../types.js";
import {
  createAgentTurnExecutionDefaults,
  setupAgentRunnerExecutionTestState,
  GENERIC_RUN_FAILURE_TEXT,
  getExecuteAgentTurnForTest,
  createRunAgentTurnParams,
  createMockTypingSignaler,
  createFollowupRun,
  createMockReplyOperation,
  requireMockCall,
  createMinimalRunAgentTurnParams,
  createTestFallbackSummaryError,
  type EmbeddedAgentParams,
} from "./agent-runner-execution.test-support.js";
import { buildKnownAgentRunFailureReplyPayload } from "./agent-runner-failure-reply.js";
import { createReplyOperation } from "./reply-run-registry.js";

const state = await setupAgentRunnerExecutionTestState();

describe("executeAgentTurn: terminal failures", () => {
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

    const executeAgentTurn = await getExecuteAgentTurnForTest();
    const result = await executeAgentTurn(createRunAgentTurnParams(createFollowupRun()));

    expect(result.kind).toBe("final");
    if (result.kind === "final") {
      expect(result.payload.text).toBe(formatBillingErrorMessage());
      expect(result.payload.text).not.toContain("All models failed");
      expect(result.payload.text).not.toContain("402 (billing)");
      expect(result.payload.text).not.toContain("Rate-limited");
    }
  });

  it("keeps the provider reset hint when the chain summary exceeds the length guard", async () => {
    // Three legs of ordinary provider text push the summary past the bound that keeps
    // provider strings from dumping HTML or JSON. This is the mid-turn surfacing path in
    // agent-runner-execution, where a run returns no usable text and the raw upstream
    // error is rendered for the user.
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

    const executeAgentTurn = await getExecuteAgentTurnForTest();
    const result = await executeAgentTurn(createRunAgentTurnParams(createFollowupRun()));

    const rendered = JSON.stringify(result);
    expect(rendered).toContain("resets 6:20pm (Europe/London)");
    expect(rendered).not.toContain("API rate limit reached. Please try again later.");
  });

  it("surfaces restart text when fallback exhaustion wraps a drain error, keeping fail bookkeeping", async () => {
    const { replyOperation, failMock } = createMockReplyOperation();
    state.runWithModelFallbackMock.mockRejectedValueOnce(
      createTestFallbackSummaryError({
        message: "fallback exhausted",
        attempts: [
          {
            provider: "anthropic",
            model: "claude",
            error: "gateway draining",
            reason: "unknown",
          },
        ],
        soonestCooldownExpiry: null,
        cause: new GatewayDrainingError(),
      }),
    );

    const executeAgentTurn = await getExecuteAgentTurnForTest();
    const result = await executeAgentTurn({
      commandBody: "hello",
      followupRun: createFollowupRun(),
      sessionCtx: {
        Provider: "whatsapp",
        MessageSid: "msg",
      } as unknown as TemplateContext,
      replyOperation,
      opts: {},
      typingSignals: createMockTypingSignaler(),
      ...createAgentTurnExecutionDefaults(),
    });

    expect(result.kind).toBe("final");
    if (result.kind === "final") {
      expect(result.payload.text).toBe(
        "⚠️ Gateway is restarting. Please wait a few seconds and try again.",
      );
    }
    const failCall = requireMockCall(failMock, 0, "reply operation fail");
    expect(failCall[0]).toBe("gateway_draining");
    expect(failCall[1]).toBeInstanceOf(GatewayDrainingError);
  });

  it("surfaces restart text when fallback exhaustion wraps a cleared lane error, keeping fail bookkeeping", async () => {
    const { replyOperation, failMock } = createMockReplyOperation();
    state.runWithModelFallbackMock.mockRejectedValueOnce(
      createTestFallbackSummaryError({
        message: "fallback exhausted",
        attempts: [
          {
            provider: "anthropic",
            model: "claude",
            error: "command lane cleared",
            reason: "unknown",
          },
        ],
        soonestCooldownExpiry: null,
        cause: new CommandLaneClearedError("session:main"),
      }),
    );

    const executeAgentTurn = await getExecuteAgentTurnForTest();
    const result = await executeAgentTurn({
      commandBody: "hello",
      followupRun: createFollowupRun(),
      sessionCtx: {
        Provider: "whatsapp",
        MessageSid: "msg",
      } as unknown as TemplateContext,
      replyOperation,
      opts: {},
      typingSignals: createMockTypingSignaler(),
      ...createAgentTurnExecutionDefaults(),
    });

    expect(result.kind).toBe("final");
    if (result.kind === "final") {
      expect(result.payload.text).toBe(
        "⚠️ Gateway is restarting. Please wait a few seconds and try again.",
      );
    }
    const failCall = requireMockCall(failMock, 0, "reply operation fail");
    expect(failCall[0]).toBe("command_lane_cleared");
    expect(failCall[1]).toBeInstanceOf(CommandLaneClearedError);
  });

  it("returns a visible failure when settlement closes without supersession", async () => {
    const agentEvents = await import("../../infra/agent-events.js");
    const emitAgentEvent = vi.mocked(agentEvents.emitAgentEvent);
    const replyOperation = createReplyOperation({
      sessionKey: "agent:main:closed-terminal",
      sessionId: "session",
      resetTriggered: false,
    });
    replyOperation.setPhase("running");
    const error = createSessionPlacementSettlementClosedAbortError();
    state.runEmbeddedAgentMock.mockRejectedValueOnce(error);
    try {
      const { executeAgentTurn } = await import("./agent-runner-execution.js");
      const result = await executeAgentTurn(createMinimalRunAgentTurnParams({ replyOperation }));
      expect(result.outcome.kind).toBe("rejected");
      if (result.outcome.kind === "rejected") {
        expect(result.outcome.payload.text).toBeTruthy();
        expect(result.outcome.payload.text).not.toBe(SILENT_REPLY_TOKEN);
      }
      expect(replyOperation.result).toMatchObject({ kind: "failed", code: "run_failed" });
      expect(state.runEmbeddedAgentMock).toHaveBeenCalledOnce();
      const terminals = emitAgentEvent.mock.calls
        .map(([event]) => event)
        .filter(
          (event) =>
            event.runId === result.runId &&
            event.stream === "lifecycle" &&
            (event.data.phase === "end" || event.data.phase === "error"),
        );
      expect(terminals).toHaveLength(1);
      expect(terminals[0]?.data.phase).toBe("error");
      expect(terminals[0]?.data.stopReason).not.toBe("superseded");
    } finally {
      replyOperation.complete();
    }
  });

  it.each([
    { reason: "restart", code: "aborted_for_restart", phase: "end", stopReason: "restart" },
    {
      reason: "superseded",
      code: "aborted_for_supersession",
      phase: "error",
      stopReason: "superseded",
    },
    {
      reason: "superseded",
      code: "aborted_for_supersession",
      phase: "error",
      stopReason: "superseded",
      restartError: true,
    },
    {
      reason: "user",
      code: "aborted_by_user",
      phase: "error",
      stopReason: "timeout",
      supersededError: true,
    },
  ] as const)(
    "records one $stopReason abort terminal event without returning a reply ($restartError)",
    async (testCase) => {
      const { reason, code, phase, stopReason } = testCase;
      const agentEvents = await import("../../infra/agent-events.js");
      const emitAgentEvent = vi.mocked(agentEvents.emitAgentEvent);
      const upstreamAbort = new AbortController();
      const replyOperation = createReplyOperation({
        sessionKey: "agent:main:abort-terminal",
        sessionId: "session",
        resetTriggered: false,
        upstreamAbortSignal: upstreamAbort.signal,
      });
      replyOperation.setPhase("running");
      const failMock = vi.spyOn(replyOperation, "fail");
      state.runEmbeddedAgentMock.mockImplementationOnce(async () => {
        if (reason === "superseded") {
          replyOperation.supersede();
        } else {
          const abortReason =
            reason === "restart"
              ? createAgentRunRestartAbortError()
              : stopReason === "timeout"
                ? new DOMException("upstream deadline exceeded", "TimeoutError")
                : new Error("caller cancelled");
          upstreamAbort.abort(abortReason);
        }
        if ("restartError" in testCase) {
          throw createAgentRunRestartAbortError();
        }
        if ("supersededError" in testCase) {
          throw createAgentRunSupersededAbortError();
        }
        throw Object.assign(new Error("aborted"), { name: "AbortError" });
      });

      try {
        const { executeAgentTurn } = await import("./agent-runner-execution.js");
        const result = await executeAgentTurn({
          ...createMinimalRunAgentTurnParams({
            replyOperation: "supersededError" in testCase ? undefined : replyOperation,
          }),
          opts: { abortSignal: upstreamAbort.signal },
          isRestartRecoveryArmed: async () => true,
        });

        expect(result.outcome).toEqual({ kind: "aborted", reason });
        expect(replyOperation.result).toEqual({ kind: "aborted", code });
        expect(failMock).not.toHaveBeenCalled();
        expect(state.runEmbeddedAgentMock).toHaveBeenCalledOnce();
        const terminals = emitAgentEvent.mock.calls
          .map(([event]) => event)
          .filter(
            (event) =>
              event.runId === result.runId &&
              event.stream === "lifecycle" &&
              (event.data.phase === "end" || event.data.phase === "error"),
          );
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
      const { executeAgentTurn } = await import("./agent-runner-execution.js");
      const { emitAgentEvent } = await import("../../infra/agent-events.js");
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
      const pending = executeAgentTurn({
        ...createMinimalRunAgentTurnParams(),
        replyOperation,
        opts: { abortSignal: upstreamAbort.signal },
      });
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
        const terminals = vi
          .mocked(emitAgentEvent)
          .mock.calls.map(([event]) => event)
          .filter(
            (event) =>
              event.runId === result.runId &&
              event.stream === "lifecycle" &&
              event.data.phase === "error",
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

  it.each([
    {
      label: "settled result",
      armed: true,
      result: {
        payloads: [{ text: "completed before the restart marker was observed" }],
        meta: {},
      },
    },
  ])("settles $label after awaiting restart recovery", async ({ label, result, armed }) => {
    const runId = `armed-restart-${label.replaceAll(" ", "-")}`;
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
    const { executeAgentTurn } = await import("./agent-runner-execution.js");

    const execution = await executeAgentTurn({
      ...createMinimalRunAgentTurnParams({ replyOperation: restartReplyOperation }),
      opts: { runId } as GetReplyOptions,
      isRestartRecoveryArmed: async () => armed,
    });

    expect(execution).toEqual({
      runId,
      outcome: { kind: "aborted", reason: "restart" },
    });
    expect(abortForRestart).toHaveBeenCalledOnce();
    expect(complete).not.toHaveBeenCalled();
    expect(restartReplyOperation.result).toEqual({
      kind: "aborted",
      code: "aborted_for_restart",
    });
    expect(failMock).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "max-turn",
      code: "cli_max_turns",
      recoveryText:
        "Claude CLI stopped after reaching the maximum number of turns (limit: 1). " +
        "OpenClaw run: run-max-turns. OpenClaw session: session-1. Claude session: claude-session-1. " +
        "Tool actions may already have run; verify their effects before retrying. " +
        "Retry with a higher --max-turns value or a narrower task.",
    },
  ])("surfaces CLI $name recovery context at normal verbosity", async ({ code, recoveryText }) => {
    const terminalStop = new FailoverError(recoveryText, {
      reason: "unknown",
      code,
      provider: "claude-cli",
      model: "sonnet",
    });
    state.runEmbeddedAgentMock.mockRejectedValueOnce(
      new AggregateError(
        [terminalStop, new Error("fork successor persistence failed")],
        "CLI turn failed and its fork successor could not be persisted",
      ),
    );

    const executeAgentTurn = await getExecuteAgentTurnForTest();
    const result = await executeAgentTurn(createMinimalRunAgentTurnParams());

    expect(result.kind).toBe("final");
    if (result.kind === "final") {
      expect(result.payload.isError).toBe(true);
      expect(result.payload.text).toBe(recoveryText);
      expect(result.payload.text).not.toBe(GENERIC_RUN_FAILURE_TEXT);
    }
  });

  it("uses heartbeat failure copy for raw external errors during heartbeat runs", async () => {
    state.runEmbeddedAgentMock.mockRejectedValueOnce(
      new Error('Command lane "main" task timed out after 120000ms'),
    );

    const executeAgentTurn = await getExecuteAgentTurnForTest();
    const result = await executeAgentTurn({
      ...createMinimalRunAgentTurnParams(),
      isHeartbeat: true,
    });

    expect(result.kind).toBe("final");
    if (result.kind !== "final") {
      throw new Error("expected final reply");
    }
    expect(result.payload.text).toBe(HEARTBEAT_EXTERNAL_RUN_FAILURE_TEXT);
    expect(result.payload.text).not.toBe(GENERIC_RUN_FAILURE_TEXT);
    expect(result.payload.text).not.toContain("/new");
  });

  it("includes heartbeat preflight reasons in terminal failure replies", async () => {
    const message =
      "Codex session became active in another runner; wait for it to finish before continuing";
    state.runEmbeddedAgentMock.mockRejectedValueOnce(new AgentHarnessPreflightError(message));

    const executeAgentTurn = await getExecuteAgentTurnForTest();
    const result = await executeAgentTurn({
      ...createMinimalRunAgentTurnParams(),
      isHeartbeat: true,
    });

    expect(result.kind).toBe("final");
    if (result.kind !== "final") {
      throw new Error("expected final reply");
    }
    expect(result.payload.text).toBe(renderHeartbeatRunFailureCopy(message));
    expect(result.payload.isError).toBe(true);
    expect(result.payload.text).not.toContain("/new");
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

  it.each([
    {
      rejection: new Error("codex app-server turn idle timed out waiting for turn/completed"),
      expected: "hasn't confirmed whether the task finished",
    },
  ])(
    "surfaces Codex app-server bridge failures instead of generic copy",
    async ({ rejection, expected }) => {
      state.runWithModelFallbackMock.mockRejectedValueOnce(rejection);

      const executeAgentTurn = await getExecuteAgentTurnForTest();
      const result = await executeAgentTurn({
        ...createMinimalRunAgentTurnParams(),
      });

      expect(result.kind).toBe("final");
      if (result.kind !== "final") {
        throw new Error("expected final reply");
      }
      expect(result.payload.text).not.toBe(GENERIC_RUN_FAILURE_TEXT);
      expect(result.payload.text).toContain("may still be running");
      expect(result.payload.text).toContain(expected);
    },
  );

  it("surfaces stale Codex session generations in groups instead of staying silent", async () => {
    state.runWithModelFallbackMock.mockRejectedValueOnce(
      new AgentHarnessSessionSupersededError(
        "Codex session generation is no longer current: secret-session-id",
      ),
    );

    const executeAgentTurn = await getExecuteAgentTurnForTest();
    const result = await executeAgentTurn({
      ...createMinimalRunAgentTurnParams({
        sessionCtx: {
          Provider: "telegram",
          Surface: "telegram",
          ChatType: "group",
          MessageSid: "msg",
        } as unknown as TemplateContext,
      }),
    });

    expect(result.kind).toBe("final");
    if (result.kind !== "final") {
      throw new Error("expected final reply");
    }
    expect(result.payload.text).not.toBe(SILENT_REPLY_TOKEN);
    expect(result.payload.text).toBe(
      "⚠️ This Codex session changed before your message could run. Please send it again.",
    );
    expect(result.payload.text).not.toContain("secret-session-id");
  });

  it("forwards sanitized generic errors on external chat channels when verbose is on", async () => {
    state.runEmbeddedAgentMock.mockRejectedValueOnce(
      new Error("INVALID_ARGUMENT: some other failure"),
    );

    const executeAgentTurn = await getExecuteAgentTurnForTest();
    const result = await executeAgentTurn({
      commandBody: "hello",
      followupRun: createFollowupRun(),
      sessionCtx: {
        Provider: "whatsapp",
        MessageSid: "msg",
      } as unknown as TemplateContext,
      opts: {},
      typingSignals: createMockTypingSignaler(),
      ...createAgentTurnExecutionDefaults(),
      resolvedVerboseLevel: "on",
    });

    expect(result.kind).toBe("final");
    if (result.kind === "final") {
      expect(result.payload.text).toBe(
        "⚠️ Agent failed before reply: INVALID_ARGUMENT: some other failure. Please try again, or use /new to start a fresh session.",
      );
    }
  });
});
