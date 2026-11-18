import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import { OAuthRefreshFailureError } from "../../agents/auth-profiles/oauth-refresh-failure.js";
import { createCliTimeoutError } from "../../agents/cli-runner/no-output-timeout-policy.js";
import { FailoverError } from "../../agents/failover-error.js";
import { AgentHarnessPreflightError } from "../../agents/harness/errors.js";
import { LiveSessionModelSwitchError } from "../../agents/live-model-switch-error.js";
import { ProviderAuthError } from "../../agents/model-auth.js";
import { getReplyPayloadMetadata } from "../reply-payload.js";
import type { TemplateContext } from "../templating.js";
import { SILENT_REPLY_TOKEN } from "../tokens.js";
import {
  PROVIDER_AUTHENTICATION_ERROR_USER_MESSAGE,
  PROVIDER_RATE_LIMIT_OR_QUOTA_ERROR_USER_MESSAGE,
  PROVIDER_INTERNAL_ERROR_USER_MESSAGE,
  setupAgentRunnerExecutionTestState,
  GENERIC_RUN_FAILURE_TEXT,
  getExecuteAgentTurnForTest,
  initialFallbackAttemptOptions,
  createMockReplyOperation,
  createMinimalRunAgentTurnParams,
  NON_DIRECT_FAILURE_SURFACE_CASES,
  createNonDirectFailureSessionCtx,
  type EmbeddedAgentParams,
  type FallbackRunnerParams,
  createTestFallbackSummaryError,
  createFollowupRun,
} from "./agent-runner-execution.test-support.js";
import type { AgentTurnParams } from "./agent-runner-execution.types.js";
import { buildKnownAgentRunFailureReplyPayload } from "./agent-runner-failure-reply.js";

const state = await setupAgentRunnerExecutionTestState();

async function executeTestTurn(
  params?: Parameters<typeof createMinimalRunAgentTurnParams>[0],
  overrides?: Partial<AgentTurnParams>,
) {
  const executeAgentTurn = await getExecuteAgentTurnForTest();
  return executeAgentTurn({ ...createMinimalRunAgentTurnParams(params), ...overrides });
}

function finalPayload(result: Awaited<ReturnType<typeof executeTestTurn>>) {
  expect(result.kind).toBe("final");
  if (result.kind !== "final") {
    throw new Error(`Expected final result, got ${result.kind}`);
  }
  return result.payload;
}

async function rejectedPayload(error: Error, surfaceIndex?: number) {
  state.runEmbeddedAgentMock.mockRejectedValueOnce(error);
  return finalPayload(
    await executeTestTurn({
      sessionCtx:
        surfaceIndex === undefined
          ? createDirectFailureSessionCtx()
          : createNonDirectFailureSessionCtx(
              expectDefined(NON_DIRECT_FAILURE_SURFACE_CASES[surfaceIndex], "failure surface"),
            ),
    }),
  );
}

function startAbortedFailure(error: Error, opts: AgentTurnParams["opts"] = {}) {
  const runnerStarted = createDeferred();
  state.runEmbeddedAgentMock.mockImplementation(async () => {
    runnerStarted.resolve();
    throw error;
  });
  const controller = new AbortController();
  const { replyOperation } = createMockReplyOperation({ abortSignal: controller.signal });
  const onBlockReply = vi.fn();
  const pending = executeTestTurn({ replyOperation, opts: { ...opts, onBlockReply } });
  const started = awaitGateBeforeSettlement(
    runnerStarted.promise,
    pending,
    "provider failure fixture did not reach the runner",
  );
  return { controller, onBlockReply, pending, started };
}

function createDirectFailureSessionCtx(provider: "discord" | "telegram" = "discord") {
  return {
    Provider: provider,
    Surface: provider,
    ChatType: "direct",
    MessageSid: "msg",
  } as unknown as TemplateContext;
}

function createOverloadSummaryError() {
  return createTestFallbackSummaryError({
    message: "All models failed (1): anthropic/claude-opus-4-1: overloaded",
    attempts: [
      {
        provider: "anthropic",
        model: "claude-opus-4-1",
        error: "overloaded",
        reason: "overloaded",
        status: 529,
      },
    ],
    soonestCooldownExpiry: null,
  });
}

const OPENAI_SERVICE_UNAVAILABLE_MESSAGE =
  "unexpected status 503 Service Unavailable: Service Unavailable, url: https://chatgpt.com/backend-api/codex/responses, cf-ray: qa-test-AMS, auth error: 503, auth error code: biscuit_baker_service_me_circuit_open";

function createOpenAiServiceUnavailableError() {
  return new FailoverError("LLM request timed out.", {
    reason: "timeout",
    provider: "openai",
    model: "gpt-5.6",
    status: 408,
    rawError: OPENAI_SERVICE_UNAVAILABLE_MESSAGE,
  });
}

describe("executeAgentTurn: provider failures", () => {
  it("preserves item-conflict recovery in the Control UI reply and saved notice", async () => {
    const expected =
      "⚠️ The AI service could not recover saved conversation state (item_conflict). Retry this turn. If it still fails, run /compact or choose another model, and share the Gateway logs with the operator.";
    state.isInternalMessageChannelMock.mockReturnValue(true);
    const payload = await rejectedPayload(
      new FailoverError(expected, {
        reason: "format",
        provider: "openai",
        code: "item_conflict",
        rawError: "An input item conflicts with an existing record.",
      }),
    );
    expect(payload).toMatchObject({ isError: true, text: expected });
    const agentEvents = await import("../../infra/agent-events.js");
    expect(vi.mocked(agentEvents.emitAgentEvent)).toHaveBeenCalledWith(
      expect.objectContaining({
        stream: "lifecycle",
        data: expect.objectContaining({ phase: "error", errorNotice: expected }),
      }),
    );
    expect(state.runEmbeddedAgentMock).toHaveBeenCalledOnce();
  });

  it("surfaces provider authentication failures in non-direct chats", async () => {
    const rawError =
      "unexpected status 401 Unauthorized: Missing bearer or basic authentication in header, url: https://api.openai.com/v1/responses";
    const payload = await rejectedPayload(
      new FailoverError("LLM request unauthorized.", {
        reason: "auth",
        provider: "openai",
        model: "gpt-5.5",
        status: 401,
        rawError,
      }),
      0,
    );
    expect(payload).toMatchObject({
      isError: true,
      text: PROVIDER_AUTHENTICATION_ERROR_USER_MESSAGE,
    });
    expect(payload.text).not.toBe(SILENT_REPLY_TOKEN);
    expect(payload.text).not.toContain(rawError);
  });

  it("surfaces provider quota guidance for generic HTTP 429 failures before reply", async () => {
    const error = new Error(
      "Something went wrong while processing your request. Please try again.",
    );
    Object.assign(error, { status: 429 });
    const payload = await rejectedPayload(error);
    expect(payload.text).toBe(PROVIDER_RATE_LIMIT_OR_QUOTA_ERROR_USER_MESSAGE);
    expect(payload.text).not.toBe(GENERIC_RUN_FAILURE_TEXT);
  });

  it.each(["partial", "control UI"])(
    "settles preflight diagnostics without replay: %s",
    async (surface) => {
      vi.useFakeTimers();
      const error = new AgentHarnessPreflightError(
        `Handoff refused after 529 OVERLOADED; reconnect before continuing. diagnostic-canary ${"x".repeat(1500)}`,
        {
          cause: { status: 529, code: "OVERLOADED" },
        },
      );
      const { replyOperation, failMock } = createMockReplyOperation();
      const onBlockReply = vi.fn();
      let partialAccepted = false;
      state.isInternalMessageChannelMock.mockReturnValue(surface === "control UI");
      state.runEmbeddedAgentMock.mockImplementationOnce(async (params: EmbeddedAgentParams) => {
        await params.onPartialReply?.({ text: "accepted partial" });
        throw error;
      });
      state.runWithModelFallbackMock
        .mockImplementationOnce(async (params: FallbackRunnerParams) => {
          if (surface === "partial") {
            return await params.run("anthropic", "claude", initialFallbackAttemptOptions(params));
          }
          throw error;
        })
        .mockResolvedValueOnce({
          result: { payloads: [{ text: "unexpected retry" }], meta: {} },
          provider: "fixture",
          model: "fixture",
          attempts: [],
        });
      const pending = executeTestTurn(
        {
          replyOperation,
          opts: {
            onBlockReply,
            onPartialReply: () => {
              partialAccepted = true;
              return true;
            },
          },
          sessionCtx:
            surface === "partial"
              ? createNonDirectFailureSessionCtx(NON_DIRECT_FAILURE_SURFACE_CASES[0])
              : createDirectFailureSessionCtx(),
        },
        { resolvedVerboseLevel: surface === "partial" ? "on" : "off" },
      );
      await vi.advanceTimersByTimeAsync(30_000);
      const result = await pending;
      expect(state.runWithModelFallbackMock).toHaveBeenCalledOnce();
      expect(failMock).toHaveBeenCalledWith("run_failed", error);
      const payload = finalPayload(result);
      expect(payload.isError).toBe(true);
      if (surface === "control UI") {
        expect(payload.text).toContain("Check the conversation before trying again");
        expect(payload.text).toContain("openclaw logs --follow");
        expect(payload.text).not.toContain("diagnostic-canary");
      } else {
        expect(payload.text).toContain("Agent failed before reply:");
        expect(payload.text).toContain("reconnect before continuing");
        expect(payload.text!.length).toBeLessThanOrEqual(1020);
      }
      expect(partialAccepted).toBe(surface === "partial");
      expect(onBlockReply).not.toHaveBeenCalled();
    },
  );
  it("reports the terminal provider failure to the dispatch owner", async () => {
    const onAgentRunTerminalOutcome = vi.fn();
    state.runEmbeddedAgentMock.mockRejectedValueOnce(new Error("provider returned HTTP 500"));

    const result = await executeTestTurn({ opts: { onAgentRunTerminalOutcome } });

    expect(result.kind).toBe("final");
    expect(onAgentRunTerminalOutcome).toHaveBeenCalledOnce();
    expect(onAgentRunTerminalOutcome).toHaveBeenCalledWith("failed");
  });

  it.each([NON_DIRECT_FAILURE_SURFACE_CASES[4]])(
    "surfaces live model switch failure after an accepted partial in $label chats",
    async (testCase) => {
      let partialDelivered = false;
      state.runEmbeddedAgentMock.mockImplementation(async (params: EmbeddedAgentParams) => {
        await params.onPartialReply?.({ text: "partial answer" });
        throw new LiveSessionModelSwitchError({ provider: "openai", model: "gpt-5.4" });
      });

      const result = await executeTestTurn(
        {
          sessionCtx: createNonDirectFailureSessionCtx(testCase),
          opts: {
            onPartialReply: () => {
              partialDelivered = true;
              return true;
            },
          },
        },
        { resolveVisibleReplyDelivery: async () => partialDelivered },
      );

      expect(result).toMatchObject({
        kind: "final",
        payload: {
          text: expect.stringContaining("Model switch could not be completed"),
          isError: true,
        },
      });
      expect(state.runEmbeddedAgentMock).toHaveBeenCalledTimes(3);
    },
  );

  it("keeps classified non-transient failures visible in non-direct chats", async () => {
    const payload = await rejectedPayload(
      new ProviderAuthError(
        "missing-provider-auth",
        "openai",
        'No API key found for provider "openai"',
      ),
      2,
    );
    expect(payload.text).not.toBe(SILENT_REPLY_TOKEN);
    expect(payload.text).toContain("openclaw doctor --fix");
  });

  it.each(["group"] as const)(
    "surfaces provider HTTP 503 failures in Discord %s chats without replaying after tool execution",
    async (chatType) => {
      state.runEmbeddedAgentMock.mockImplementationOnce(async (params: EmbeddedAgentParams) => {
        params.onExecutionPhase?.({ phase: "tool_execution_started", tool: "exec" });
        throw createOpenAiServiceUnavailableError();
      });

      const result = await executeTestTurn({
        sessionCtx: {
          Provider: "discord",
          Surface: "discord",
          ChatType: chatType,
          GroupSubject: "agent group",
          GroupChannel: "#general",
          MessageSid: "msg",
        } as unknown as TemplateContext,
      });

      expect(state.runEmbeddedAgentMock).toHaveBeenCalledTimes(1);
      const payload = finalPayload(result);
      expect(payload).toMatchObject({ isError: true, text: PROVIDER_INTERNAL_ERROR_USER_MESSAGE });
      expect(payload.text).not.toBe(SILENT_REPLY_TOKEN);
      expect(payload.text).not.toContain(OPENAI_SERVICE_UNAVAILABLE_MESSAGE);
      expect(getReplyPayloadMetadata(payload)).toMatchObject({
        deliverDespiteSourceReplySuppression: true,
      });
    },
  );

  it("surfaces typed periodic rate-limit details in non-direct chats", async () => {
    const periodicLimitMessage = "You've hit your weekly limit · resets 6pm (UTC)";
    const payload = await rejectedPayload(
      new FailoverError(periodicLimitMessage, {
        reason: "rate_limit",
        provider: "anthropic",
        model: "claude-opus-4-1",
        rawError: periodicLimitMessage,
      }),
      4,
    );
    expect(payload.isError).toBe(true);
    expect(payload.text).not.toBe(SILENT_REPLY_TOKEN);
    expect(payload.text).toContain("weekly limit");
    expect(payload.text).toContain("resets 6pm");
    expect(payload.text).not.toContain("few minutes");
  });

  it("scopes fallback exhaustion copy to the attempted models", () => {
    const payload = buildKnownAgentRunFailureReplyPayload({
      err: createTestFallbackSummaryError({
        message: "fallback exhausted",
        attempts: [
          {
            provider: "anthropic",
            model: "claude-opus-4-1",
            error: "rate limited",
            reason: "rate_limit",
          },
          {
            provider: "openai",
            model: "gpt-5.5",
            error: "overloaded",
            reason: "overloaded",
          },
        ],
        soonestCooldownExpiry: null,
      }),
      sessionCtx: createMinimalRunAgentTurnParams().sessionCtx,
      resolvedVerboseLevel: "off",
    });

    expect(payload?.text).toBe("⚠️ The AI services are busy. Please try again in a few minutes.");
  });

  it("does not send an overload status notice from the outer reply layer", async () => {
    vi.useFakeTimers();
    state.runWithModelFallbackMock.mockRejectedValueOnce(createOverloadSummaryError());
    const onBlockReply = vi.fn();

    const result = await executeTestTurn({ opts: { onBlockReply } });

    expect(state.runWithModelFallbackMock).toHaveBeenCalledTimes(1);
    expect(result.kind).toBe("final");
    expect(onBlockReply).not.toHaveBeenCalled();
  });

  it.each(["tool_execution_started"] as const)(
    "does not replay an overloaded turn after %s",
    async (phase) => {
      state.runEmbeddedAgentMock.mockImplementationOnce(async (params: EmbeddedAgentParams) => {
        params.onExecutionPhase?.({ phase });
        throw new Error("model is overloaded");
      });

      const result = await executeTestTurn();

      expect(state.runEmbeddedAgentMock).toHaveBeenCalledTimes(1);
      expect(finalPayload(result).text).toContain("overloaded");
    },
  );

  it.each(["assistant_output_started"] as const)(
    "does not replay a CLI timeout after %s",
    async (phase) => {
      state.runEmbeddedAgentMock.mockImplementationOnce(async (params: EmbeddedAgentParams) => {
        params.onExecutionPhase?.({ phase });
        throw createCliTimeoutError(
          { provider: "claude-cli" },
          {
            mode: "overall",
            timeoutSeconds: 600,
            observedActivity: true,
            activeToolCount: 0,
            backgroundTaskCount: 0,
          },
          "cli_overall_timeout",
        );
      });

      const result = await executeTestTurn();

      expect(state.runEmbeddedAgentMock).toHaveBeenCalledTimes(1);
      const payload = finalPayload(result);
      expect(payload.text).toContain("task took too long");
      expect(payload.text).toContain("Check its results before trying again");
    },
  );

  it("keeps overload failure handling terminal when the turn is aborted", async () => {
    vi.useFakeTimers();
    const failureReported = createDeferred();
    const onAgentRunTerminalOutcome = vi.fn(() => failureReported.resolve());
    const { controller, onBlockReply, pending, started } = startAbortedFailure(
      new Error("model is overloaded"),
      { onAgentRunTerminalOutcome },
    );
    await started;
    await awaitGateBeforeSettlement(
      failureReported.promise,
      pending,
      "provider failure fixture did not report its terminal outcome",
    );
    controller.abort();
    await expect(pending).resolves.toMatchObject({
      kind: "final",
    });
    expect(state.runEmbeddedAgentMock).toHaveBeenCalledTimes(1);
    expect(onAgentRunTerminalOutcome).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(onBlockReply).not.toHaveBeenCalled();
    const agentEvents = await import("../../infra/agent-events.js");
    expect(vi.mocked(agentEvents.emitAgentEvent)).toHaveBeenCalledWith(
      expect.objectContaining({
        stream: "lifecycle",
        data: expect.objectContaining({ phase: "error", executionSettled: true }),
      }),
    );
  });

  it("keeps transient HTTP failure handling terminal when the turn is aborted", async () => {
    vi.useFakeTimers();
    const { controller, onBlockReply, pending, started } = startAbortedFailure(
      new FailoverError("provider request timed out", {
        reason: "timeout",
        provider: "anthropic",
        model: "claude-opus-4-1",
      }),
    );
    await started;
    controller.abort();
    await expect(pending).resolves.toMatchObject({
      kind: "final",
    });
    expect(state.runEmbeddedAgentMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(state.runEmbeddedAgentMock).toHaveBeenCalledTimes(1);
    expect(onBlockReply).not.toHaveBeenCalled();
  });

  it("redacts classified raw Codex API payloads in verbose external errors", async () => {
    const raw =
      'Codex error: {"type":"error","error":{"type":"server_error","message":"Something exploded"},"sequence_number":2}';
    state.runEmbeddedAgentMock.mockRejectedValueOnce(new Error(raw));
    const payload = finalPayload(
      await executeTestTurn(undefined, {
        commandBody: "hello",
        resolvedVerboseLevel: "on",
      }),
    );

    expect(payload.text).toBe("⚠️ The AI service is having trouble. Please try again in a moment.");
    expect(payload.text).not.toContain("Something exploded");
  });
});

describe("provider failures seen by non-owners in shared chats", () => {
  const UNAVAILABLE_TEXT = "⚠️ This assistant is temporarily unavailable. Please try again later.";
  const DOCTOR_HINT = "openclaw doctor --fix";
  const OWNER_LIST = ["discord:owner-1"];
  const sharedChat = createNonDirectFailureSessionCtx(
    expectDefined(NON_DIRECT_FAILURE_SURFACE_CASES[1], "Discord channel"),
  );
  const missingOpenAiKey = () =>
    new ProviderAuthError(
      "missing-provider-auth",
      "openai",
      'No API key found for provider "openai". Configure an API key.',
    );

  async function replyTo(
    error: Error,
    senderIsOwner: boolean | undefined,
    sessionCtx: TemplateContext = sharedChat,
    ownerAllowFrom: readonly string[] = OWNER_LIST,
  ) {
    state.runEmbeddedAgentMock.mockRejectedValueOnce(error);
    const followupRun = createFollowupRun({ senderIsOwner });
    followupRun.run.config = {
      ...followupRun.run.config,
      commands: { ownerAllowFrom: [...ownerAllowFrom] },
    };
    return finalPayload(await executeTestTurn({ followupRun, sessionCtx }));
  }

  it.each([
    ["a missing API key", missingOpenAiKey],
    [
      "an expired provider login",
      () => new OAuthRefreshFailureError({ provider: "openai", message: "invalid_grant" }),
    ],
    [
      "an unpaid provider account",
      () =>
        new FailoverError("402 insufficient credits", {
          reason: "billing",
          provider: "openai",
          model: "gpt-5.5",
          status: 402,
          // A saved-login cooldown is not a time when billing will work again.
          soonestCooldownExpiry: Date.now() + 2 * 60 * 60 * 1000,
        }),
    ],
    [
      "a provider outage",
      () =>
        new FailoverError("503 service unavailable", {
          reason: "server_error",
          provider: "openai",
          model: "gpt-5.5",
          status: 503,
        }),
    ],
    [
      "a billing failure followed by a fallback timeout",
      () =>
        createTestFallbackSummaryError({
          message: "All models failed (2)",
          attempts: [
            { provider: "openai", model: "gpt-5.5", error: "402", reason: "billing", status: 402 },
            { provider: "anthropic", model: "claude", error: "timed out", reason: "timeout" },
          ],
        }),
    ],
  ])("says the assistant is unavailable for %s", async (_label, makeError) => {
    const errorLog = vi.mocked((await import("../../runtime.js")).defaultRuntime.error);
    errorLog.mockClear();
    const payload = await replyTo(makeError(), false);
    expect(payload).toMatchObject({ isError: true, text: UNAVAILABLE_TEXT });
    expect(payload.presentation).toBeUndefined();
    // The operator still gets the cause in the gateway log.
    expect(errorLog).toHaveBeenCalledWith(
      expect.stringContaining("Embedded agent failed before reply"),
    );
  });

  it.each([
    ["the owner in the same chat", true, sharedChat, OWNER_LIST],
    ["a non-owner in a direct chat", false, createDirectFailureSessionCtx(), OWNER_LIST],
    ["a sender of unknown ownership", undefined, sharedChat, OWNER_LIST],
    ["any sender when no owner list is configured", false, sharedChat, []],
  ] as const)(
    "keeps setup guidance for %s",
    async (_label, senderIsOwner, sessionCtx, ownerAllowFrom) => {
      const payload = await replyTo(missingOpenAiKey(), senderIsOwner, sessionCtx, ownerAllowFrom);
      expect(payload.text).toContain(DOCTOR_HINT);
    },
  );

  it("keeps the completed-work warning when a run times out", async () => {
    const timeout = createCliTimeoutError(
      { provider: "claude-cli" },
      {
        mode: "overall",
        timeoutSeconds: 600,
        observedActivity: true,
        activeToolCount: 0,
        backgroundTaskCount: 0,
      },
      "cli_overall_timeout",
    );
    const payload = await replyTo(timeout, false);
    expect(payload.text).toContain("Check its results before trying again");
  });

  it("keeps failures that are not about the provider", async () => {
    const payload = await replyTo(
      new Error("Preflight compaction required but failed: summary too large"),
      false,
    );
    expect(payload.text).not.toBe(UNAVAILABLE_TEXT);
  });

  it("names the provider's reset time without naming the provider", () => {
    const payload = buildKnownAgentRunFailureReplyPayload({
      err: new FailoverError("429 rate limited", {
        reason: "rate_limit",
        provider: "openai",
        model: "gpt-5.5",
        status: 429,
        rateLimitResetAt: Date.UTC(2099, 0, 1, 15, 0),
      }),
      sessionCtx: sharedChat,
      resolvedVerboseLevel: undefined,
      config: {
        commands: { ownerAllowFrom: OWNER_LIST },
        ui: { prefs: { locale: "en-US" } },
        agents: { defaults: { userTimezone: "UTC" } },
      },
      senderIsOwner: false,
    });
    expect(payload?.isError).toBe(true);
    // ICU versions differ in the separator between date and time.
    expect(payload?.text).toMatch(
      /^⚠️ This assistant is temporarily unavailable\. Please try again after Jan 1, 2099\D+3:00\sPM UTC\.$/u,
    );
  });
});
