import { describe, expect, it, onTestFinished, vi } from "vitest";
import { createCliTimeoutError } from "../../agents/cli-runner/no-output-timeout-policy.js";
import { HEARTBEAT_EXTERNAL_RUN_FAILURE_TEXT } from "../../agents/failover/user-copy.js";
import { LiveSessionModelSwitchError } from "../../agents/live-model-switch-error.js";
import type { SessionEntry } from "../../config/sessions.js";
import { withSessionControllerOwner } from "../../sessions/session-controller.context.js";
import { createReplyOperation } from "../../sessions/session-controller.js";
import { resolveRunAfterAutoFallbackPrimaryProbeRecheck } from "./agent-runner-auto-fallback.js";
import {
  setupAgentRunnerExecutionTestState,
  getExecuteAgentTurnForTest,
  createFollowupRun,
  fallbackAttemptOptions,
  initialFallbackAttemptOptions,
  runInitialFallbackAttempt,
  createMockReplyOperation,
  expectMockCallArgFields,
  expectRecordFields,
  createMinimalRunAgentTurnParams,
} from "./agent-runner-execution.test-support.js";
import type {
  FallbackRunnerParams,
  EmbeddedAgentParams,
} from "./agent-runner-execution.test-support.js";
import type { AgentTurnParams } from "./agent-runner-execution.types.js";
import { prepareReplyToolAuthority } from "./reply-tool-authority.js";

const state = await setupAgentRunnerExecutionTestState();
const executeAgentTurn = await getExecuteAgentTurnForTest();
const emitAgentEvent = vi.mocked((await import("../../infra/agent-events.js")).emitAgentEvent);

function execute(
  params?: Parameters<typeof createMinimalRunAgentTurnParams>[0],
  overrides?: Partial<AgentTurnParams>,
) {
  return executeAgentTurn({ ...createMinimalRunAgentTurnParams(params), ...overrides });
}

function followupWith(run: Partial<ReturnType<typeof createFollowupRun>["run"]>) {
  const followup = createFollowupRun();
  Object.assign(followup.run, run);
  return followup;
}

function lifecycleEvents(runId: string) {
  return emitAgentEvent.mock.calls
    .map(([event]) => event)
    .filter((event) => event.runId === runId && event.stream === "lifecycle");
}

async function createCliReplyOperation(followupRun: ReturnType<typeof createFollowupRun>) {
  const sessionKey = followupRun.run.sessionKey;
  if (!sessionKey) {
    throw new Error("CLI probe fixture requires its canonical session key");
  }
  const replyOperation = createReplyOperation({
    sessionKey,
    sessionId: followupRun.run.sessionId,
    resetTriggered: false,
  });
  await replyOperation.bindToolAuthoritySnapshotAsync(prepareReplyToolAuthority(followupRun));
  const failMock = vi.spyOn(replyOperation, "fail");
  const completeMock = vi.spyOn(replyOperation, "complete");
  onTestFinished(() => replyOperation.complete());
  return { replyOperation, failMock, completeMock };
}

describe("executeAgentTurn: primary probe routing", () => {
  it.each([
    { kind: "queued_followup", model: "claude", auth: "anthropic:admitted" },
    { kind: "visible", model: "claude-opus-4-7", auth: "anthropic:later" },
  ] as const)("uses the $kind probe selection at execution", async ({ kind, model, auth }) => {
    const followupRun = followupWith({
      authProfileId: "anthropic:admitted",
      authProfileIdSource: "user",
      autoFallbackPrimaryProbe: {
        provider: "anthropic",
        model: "claude",
        fallbackProvider: "anthropic",
        fallbackModel: "fallback",
      },
    });
    const sessionEntry: SessionEntry = {
      sessionId: followupRun.run.sessionId,
      updatedAt: 2,
      providerOverride: "anthropic",
      modelOverride: "claude-opus-4-7",
      modelOverrideSource: "user",
      authProfileOverride: "anthropic:later",
      authProfileOverrideSource: "user",
    };
    const operation = createReplyOperation({
      sessionKey: "main",
      sessionId: followupRun.run.sessionId,
      turnKind: kind,
      resetTriggered: false,
    });
    await operation.bindToolAuthoritySnapshotAsync(prepareReplyToolAuthority(followupRun));
    state.runWithModelFallbackMock.mockImplementationOnce(async (params: FallbackRunnerParams) => ({
      result: await runInitialFallbackAttempt(params),
      provider: params.provider,
      model: params.model,
      attempts: [],
    }));
    state.runEmbeddedAgentMock.mockResolvedValue({ payloads: [{ text: "ok" }], meta: {} });
    try {
      await execute(
        { followupRun, replyOperation: operation },
        {
          activeSessionStore: { main: sessionEntry },
          getActiveSessionEntry: () => sessionEntry,
        },
      );
      // Queued admission already owns selection; a later session preference is
      // still live state, but must not replace the provider request being started.
      expect(state.runEmbeddedAgentMock).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ provider: "anthropic", model, authProfileId: auth }),
      );
    } finally {
      operation.complete();
    }
  });

  it("rechecks queued auto fallback primary probes before running", async () => {
    const { markAutoFallbackPrimaryProbe } = await import("../../agents/agent-scope.js");
    const probe = {
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      fallbackProvider: "google",
      fallbackModel: "gemini-3-pro",
      fallbackAuthProfileId: "google:fallback",
      fallbackAuthProfileIdSource: "auto" as const,
    };
    markAutoFallbackPrimaryProbe({
      probe,
      sessionKey: "main",
    });
    const sessionEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: 1,
      providerOverride: "google",
      modelOverride: "gemini-3-pro",
      modelOverrideSource: "auto",
      modelOverrideFallbackOriginProvider: "anthropic",
      modelOverrideFallbackOriginModel: "claude-sonnet-4-6",
      authProfileOverride: "google:fallback",
      authProfileOverrideSource: "auto",
    };
    const run = createFollowupRun().run;
    run.provider = "anthropic";
    run.model = "claude-sonnet-4-6";
    run.authProfileId = "anthropic:primary";
    run.authProfileIdSource = "auto";
    run.autoFallbackPrimaryProbe = probe;

    expect(
      resolveRunAfterAutoFallbackPrimaryProbeRecheck({
        run,
        entry: sessionEntry,
        sessionKey: "main",
      }),
    ).toMatchObject({
      provider: "google",
      model: "gemini-3.1-pro-preview",
      requestedRouteResolution: "resolved",
      authProfileId: "google:fallback",
      authProfileIdSource: "auto",
      autoFallbackPrimaryProbe: undefined,
    });
  });

  it("drops stale queued primary probes after a user model switch", async () => {
    const probe = {
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      fallbackProvider: "google",
      fallbackModel: "gemini-3-pro",
    };
    const sessionEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: 1,
      modelOverride: "openai/gpt-5.4",
      modelOverrideSource: "user",
      authProfileOverride: "openai:work",
      authProfileOverrideSource: "user",
    };
    const run = createFollowupRun().run;
    run.provider = "anthropic";
    run.model = "claude-sonnet-4-6";
    run.autoFallbackPrimaryProbe = probe;

    expect(
      resolveRunAfterAutoFallbackPrimaryProbeRecheck({
        run,
        entry: sessionEntry,
        sessionKey: "main",
      }),
    ).toMatchObject({
      provider: "openai",
      model: "gpt-5.4",
      requestedRouteResolution: "raw",
      authProfileId: "openai:work",
      authProfileIdSource: "user",
      modelOverrideSource: "user",
      autoFallbackPrimaryProbe: undefined,
    });
  });

  it.each([
    { name: "legacy user", marker: undefined, expectedSource: "user" as const },
    { name: "marker-backed auto", marker: 0, expectedSource: "auto" as const },
  ])(
    "canonicalizes a source-less $name auth profile during queued probe recheck",
    ({ marker, expectedSource }) => {
      const probe = {
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        fallbackProvider: "google",
        fallbackModel: "gemini-3-pro",
      };
      const sessionEntry: SessionEntry = {
        sessionId: "session",
        updatedAt: 1,
        providerOverride: "openai",
        modelOverride: "gpt-5.4",
        modelOverrideSource: "user",
        authProfileOverride: "openai:work",
        ...(marker === undefined ? {} : { authProfileOverrideCompactionCount: marker }),
      };
      const run = createFollowupRun().run;
      run.provider = probe.provider;
      run.model = probe.model;
      run.autoFallbackPrimaryProbe = probe;

      expect(
        resolveRunAfterAutoFallbackPrimaryProbeRecheck({
          run,
          entry: sessionEntry,
          sessionKey: "main",
        }),
      ).toMatchObject({
        provider: "openai",
        model: "gpt-5.4",
        authProfileId: "openai:work",
        authProfileIdSource: expectedSource,
        autoFallbackPrimaryProbe: undefined,
      });
    },
  );

  it("propagates rechecked user selections to post-run state", async () => {
    const sessionKey = "rechecked-user-selection";
    const sessionEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: 1,
      providerOverride: "openai",
      modelOverride: "gpt-5.4",
      modelOverrideSource: "user",
      authProfileOverride: "openai:work",
      authProfileOverrideSource: "user",
    };
    const activeSessionStore = { [sessionKey]: sessionEntry };
    const staleAutoEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: 1,
      providerOverride: "google",
      modelOverride: "gemini-3-pro",
      modelOverrideSource: "auto",
      modelOverrideFallbackOriginProvider: "anthropic",
      modelOverrideFallbackOriginModel: "claude-sonnet-4-6",
    };
    const followupRun = createFollowupRun();
    followupRun.run.provider = "anthropic";
    followupRun.run.model = "claude-sonnet-4-6";
    followupRun.run.autoFallbackPrimaryProbe = {
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      fallbackProvider: "google",
      fallbackModel: "gemini-3-pro",
    };
    state.runWithModelFallbackMock.mockImplementationOnce(async (params: FallbackRunnerParams) => ({
      result: await params.run(
        params.provider,
        params.model,
        initialFallbackAttemptOptions(params),
      ),
      provider: params.provider,
      model: params.model,
      attempts: [],
    }));
    state.runEmbeddedAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "user model" }],
      meta: {
        agentMeta: {
          provider: "openai",
          model: "gpt-5.4",
        },
      },
    });

    await executeAgentTurn({
      ...createMinimalRunAgentTurnParams({ followupRun }),
      sessionKey,
      activeSessionStore,
      getActiveSessionEntry: () => staleAutoEntry,
    });

    expectRecordFields(followupRun.run as unknown as Record<string, unknown>, {
      provider: "openai",
      model: "gpt-5.4",
      authProfileId: "openai:work",
      authProfileIdSource: "user",
      modelOverrideSource: "user",
    });
    expect(followupRun.run.autoFallbackPrimaryProbe).toBeUndefined();
    expectRecordFields(activeSessionStore[sessionKey] as unknown as Record<string, unknown>, {
      providerOverride: "openai",
      modelOverride: "gpt-5.4",
      modelOverrideSource: "user",
    });
  });

  it("drops stale queued probe metadata after the auto fallback pin is cleared", () => {
    const probe = {
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      fallbackProvider: "google",
      fallbackModel: "gemini-3-pro",
    };
    const sessionEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: 1,
      authProfileOverride: "google:fallback",
      authProfileOverrideSource: "user",
    };
    const run = createFollowupRun().run;
    run.provider = "anthropic";
    run.model = "claude-sonnet-4-6";
    run.hasSessionModelOverride = true;
    run.modelOverrideSource = "auto";
    run.hasAutoFallbackProvenance = true;
    run.autoFallbackPrimaryProbe = probe;

    const rechecked = resolveRunAfterAutoFallbackPrimaryProbeRecheck({
      run,
      entry: sessionEntry,
      sessionKey: "main",
    });
    expect(rechecked).toMatchObject({
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      autoFallbackPrimaryProbe: undefined,
    });
    expect(rechecked.authProfileId).toBeUndefined();
    expect(rechecked.authProfileIdSource).toBeUndefined();
    expect(rechecked.hasSessionModelOverride).toBeUndefined();
    expect(rechecked.modelOverrideSource).toBeUndefined();
    expect(rechecked.hasAutoFallbackProvenance).toBeUndefined();
  });

  it("does not clear an auto-fallback pin for an exhausted preserved result", async () => {
    const probe = {
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      fallbackProvider: "google",
      fallbackModel: "gemini-3-pro",
      fallbackAuthProfileId: "google:fallback",
      fallbackAuthProfileIdSource: "auto" as const,
    };
    const followupRun = createFollowupRun();
    followupRun.run.provider = probe.provider;
    followupRun.run.model = probe.model;
    followupRun.run.autoFallbackPrimaryProbe = probe;
    const sessionKey = "exhausted-primary-probe";
    const sessionEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: 1,
      providerOverride: probe.fallbackProvider,
      modelOverride: probe.fallbackModel,
      modelOverrideSource: "auto",
      modelOverrideFallbackOriginProvider: probe.provider,
      modelOverrideFallbackOriginModel: probe.model,
      authProfileOverride: probe.fallbackAuthProfileId,
      authProfileOverrideSource: "auto",
    };
    const activeSessionStore: Record<string, SessionEntry> = { [sessionKey]: sessionEntry };
    const exhaustedResult = {
      payloads: [{ text: "Terminal tool summary", isError: true }],
      meta: {
        error: {
          kind: "incomplete_turn",
          message: "All fallback candidates ended incomplete",
          fallbackSafe: true,
          terminalPresentation: true,
        },
      },
    };
    state.runEmbeddedAgentMock.mockImplementationOnce(async (params: EmbeddedAgentParams) => {
      await params.onAgentEvent?.({
        stream: "lifecycle",
        data: {
          phase: "finishing",
          error: "All fallback candidates ended incomplete",
          livenessState: "blocked",
          providerStarted: true,
          replayInvalid: true,
          timeoutPhase: "provider",
        },
      });
      return exhaustedResult;
    });
    state.runWithModelFallbackMock.mockImplementationOnce(async (params: FallbackRunnerParams) => ({
      outcome: "exhausted",
      result: await params.run(probe.provider, probe.model, initialFallbackAttemptOptions(params)),
      provider: probe.provider,
      model: probe.model,
      attempts: [
        { provider: probe.provider, model: probe.model, error: "incomplete" },
        {
          provider: probe.fallbackProvider,
          model: probe.fallbackModel,
          error: "incomplete",
        },
      ],
    }));
    const { replyOperation, failMock } = createMockReplyOperation();
    const completeMock = vi.spyOn(replyOperation, "complete");
    const result = await executeAgentTurn({
      ...createMinimalRunAgentTurnParams({ followupRun, replyOperation }),
      sessionKey,
      activeSessionStore,
      getActiveSessionEntry: () => activeSessionStore[sessionKey],
    });

    expect(result).toMatchObject({
      kind: "success",
      fallbackExhausted: true,
      fallbackProvider: probe.provider,
      fallbackModel: probe.model,
      runResult: exhaustedResult,
    });
    expect(activeSessionStore[sessionKey]).toMatchObject({
      providerOverride: probe.fallbackProvider,
      modelOverride: probe.fallbackModel,
      modelOverrideSource: "auto",
      modelOverrideFallbackOriginProvider: probe.provider,
      modelOverrideFallbackOriginModel: probe.model,
    });
    expect(completeMock).not.toHaveBeenCalled();
    expect(failMock).toHaveBeenCalledWith("run_failed", expect.any(Error));
    expect(
      emitAgentEvent.mock.calls
        .map((call) => call[0])
        .find(
          (event) =>
            event.stream === "lifecycle" &&
            event.data.phase === "error" &&
            event.data.executionSettled === true &&
            event.data.livenessState === "blocked" &&
            event.data.providerStarted === true &&
            event.data.replayInvalid === true &&
            event.data.timeoutPhase === "provider",
        ),
    ).toBeDefined();
  });

  it("reports a completed non-fallbackable error result as a failure terminal", async () => {
    const terminalErrorResult = {
      payloads: [{ text: "Command may have changed state", isError: true }],
      meta: {
        replayInvalid: true,
        error: {
          kind: "incomplete_turn",
          message: "raw provider detail should stay private",
          fallbackSafe: false,
        },
      },
    };
    state.runEmbeddedAgentMock.mockImplementationOnce(async (params: EmbeddedAgentParams) => {
      await params.onAgentEvent?.({
        stream: "lifecycle",
        data: {
          phase: "finishing",
          error: "Command may have changed state",
          replayInvalid: true,
        },
      });
      return terminalErrorResult;
    });
    state.runWithModelFallbackMock.mockImplementationOnce(async (params: FallbackRunnerParams) => ({
      outcome: "completed",
      result: await params.run("anthropic", "claude", initialFallbackAttemptOptions(params)),
      provider: "anthropic",
      model: "claude",
      attempts: [],
    }));
    const { replyOperation, failMock } = createMockReplyOperation();
    const completeMock = vi.spyOn(replyOperation, "complete");
    const result = await executeAgentTurn(
      createMinimalRunAgentTurnParams({
        replyOperation,
        opts: { runId: "run-non-fallbackable-error" },
      }),
    );

    expect(result).toMatchObject({ kind: "success", runResult: terminalErrorResult });
    expect(completeMock).not.toHaveBeenCalled();
    expect(failMock).toHaveBeenCalledWith("run_failed", expect.any(Error));
    const terminalLifecycleEvents = emitAgentEvent.mock.calls
      .map((call) => call[0])
      .filter(
        (event) => event.runId === "run-non-fallbackable-error" && event.stream === "lifecycle",
      );
    expect(terminalLifecycleEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          data: expect.objectContaining({
            phase: "error",
            error: "Command may have changed state",
            executionSettled: true,
            replayInvalid: true,
          }),
        }),
      ]),
    );
    expect(
      terminalLifecycleEvents.some(
        (event) => event.data.phase === "end" || event.data.fallbackExhaustedFailure === true,
      ),
    ).toBe(false);
    expect(JSON.stringify(terminalLifecycleEvents)).not.toContain("raw provider detail");
  });

  it("surfaces an empty heartbeat terminal result through the normal reply path", async () => {
    state.runEmbeddedAgentMock.mockResolvedValueOnce({
      payloads: [],
      meta: {
        error: {
          kind: "tool_result_mismatch",
          message: "Agent run reached a terminal error before reply delivery.",
        },
      },
    });
    state.runWithModelFallbackMock.mockImplementationOnce(async (params: FallbackRunnerParams) => ({
      outcome: "completed",
      result: await params.run("anthropic", "claude", initialFallbackAttemptOptions(params)),
      provider: "anthropic",
      model: "claude",
      attempts: [],
    }));
    const { replyOperation, failMock } = createMockReplyOperation();

    const result = await execute(
      { replyOperation },
      {
        isHeartbeat: true,
      },
    );

    expect(result).toMatchObject({
      kind: "success",
      terminalFailurePayload: {
        text: HEARTBEAT_EXTERNAL_RUN_FAILURE_TEXT,
        isError: true,
      },
      runResult: {
        payloads: [],
      },
    });
    expect(failMock).toHaveBeenCalledWith("run_failed", expect.any(Error));
  });

  it("reports exhausted CLI preserved earlier candidate without a success terminal", async () => {
    state.isCliProviderMock.mockReturnValue(true);
    state.runWithModelFallbackMock.mockImplementationOnce(async (params: FallbackRunnerParams) => ({
      outcome: "exhausted",
      result: await params.run("codex-cli", "gpt-5.5", initialFallbackAttemptOptions(params)),
      provider: "codex-cli",
      model: "gpt-5.4",
      attempts: [{ provider: "codex-cli", model: "gpt-5.4", error: "incomplete" }],
    }));
    state.runCliAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "Terminal tool summary", isError: true }],
      meta: {
        error: {
          kind: "incomplete_turn",
          message: "CLI turn ended incomplete",
        },
      },
    });
    const followupRun = followupWith({ provider: "codex-cli", model: "gpt-5.4" });
    const { replyOperation, failMock, completeMock } = await createCliReplyOperation(followupRun);
    const result = await withSessionControllerOwner(replyOperation, () =>
      execute({
        followupRun,
        replyOperation,
        opts: { runId: "run-cli-exhausted" },
      }),
    );

    expect(state.runCliAgentMock).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      kind: "success",
      fallbackExhausted: true,
      fallbackProvider: "codex-cli",
      fallbackModel: "gpt-5.4",
    });
    expect(completeMock).not.toHaveBeenCalled();
    expect(failMock).toHaveBeenCalledWith("run_failed", expect.any(Error));
    const events = lifecycleEvents("run-cli-exhausted");
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          data: expect.objectContaining({ phase: "error", executionSettled: true }),
        }),
      ]),
    );
    expect(events.some((event) => event.data.phase === "end")).toBe(false);
  });

  it("preserves a CLI watchdog timeout through the lifecycle backstop", async () => {
    state.isCliProviderMock.mockReturnValue(true);
    state.runWithModelFallbackMock.mockImplementationOnce(async (params: FallbackRunnerParams) => {
      try {
        return await params.run("codex-cli", "gpt-5.4", initialFallbackAttemptOptions(params));
      } catch (cause) {
        throw new Error("All model fallback candidates failed", { cause });
      }
    });
    state.runCliAgentMock.mockRejectedValueOnce(
      createCliTimeoutError(
        { provider: "codex-cli", model: "gpt-5.4" },
        {
          mode: "no-output",
          timeoutSeconds: 1,
          observedActivity: false,
          activeToolCount: 0,
          backgroundTaskCount: 0,
        },
      ),
    );
    const followupRun = followupWith({ provider: "codex-cli", model: "gpt-5.4" });
    const { replyOperation } = await createCliReplyOperation(followupRun);
    await withSessionControllerOwner(replyOperation, () =>
      execute({
        followupRun,
        replyOperation,
        opts: { runId: "run-cli-timeout" },
      }),
    );

    expect(
      lifecycleEvents("run-cli-timeout").find((event) => event.data.phase === "error")?.data,
    ).toMatchObject({
      stopReason: "timeout",
      timeoutPhase: "provider",
      executionSettled: true,
    });
  });

  it("keeps primary auth on same-provider primary probes", async () => {
    const probe = {
      provider: "openai",
      model: "gpt-5.5",
      fallbackProvider: "openai",
      fallbackModel: "gpt-5.4",
      fallbackAuthProfileId: "openai:fallback",
      fallbackAuthProfileIdSource: "auto" as const,
    };
    const followupRun = followupWith({
      provider: "openai",
      model: "gpt-5.5",
      authProfileId: "openai:primary",
      authProfileIdSource: "auto",
      autoFallbackPrimaryProbe: probe,
    });
    const operation = createReplyOperation({
      sessionKey: "main",
      sessionId: followupRun.run.sessionId,
      resetTriggered: false,
    });
    await operation.bindToolAuthoritySnapshotAsync(prepareReplyToolAuthority(followupRun));
    const steeringRoutes: Array<typeof operation.automaticFallbackRoute> = [];
    state.runWithModelFallbackMock.mockImplementationOnce(async (params: FallbackRunnerParams) => {
      await params.run("openai", "gpt-5.5", initialFallbackAttemptOptions(params));
      return {
        result: await params.run("openai", "gpt-5.4", fallbackAttemptOptions(params, "unknown")),
        provider: "openai",
        model: "gpt-5.4",
        attempts: [{ provider: "openai", model: "gpt-5.5", error: "rate limit" }],
      };
    });
    state.runEmbeddedAgentMock.mockImplementation(async () => {
      steeringRoutes.push(operation.automaticFallbackRoute);
      return { payloads: [{ text: "candidate" }], meta: {} };
    });

    try {
      await execute({ followupRun, replyOperation: operation });
    } finally {
      operation.complete();
    }
    expect(steeringRoutes).toEqual([undefined, { provider: "openai", model: "gpt-5.4" }]);

    expectMockCallArgFields(state.runEmbeddedAgentMock, 0, "primary run", {
      provider: "openai",
      model: "gpt-5.5",
      authProfileId: "openai:primary",
      authProfileIdSource: "auto",
    });
    expectMockCallArgFields(state.runEmbeddedAgentMock, 1, "fallback run", {
      provider: "openai",
      model: "gpt-5.4",
      authProfileId: "openai:fallback",
      authProfileIdSource: "auto",
    });
  });

  it("does not clear a concurrent user selection after primary probe success", async () => {
    const probe = {
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      fallbackProvider: "google",
      fallbackModel: "gemini-3-pro",
    };
    const sessionKey = "concurrent-user-switch-during-probe";
    const staleAutoEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: 1,
      providerOverride: "google",
      modelOverride: "gemini-3-pro",
      modelOverrideSource: "auto",
      modelOverrideFallbackOriginProvider: "anthropic",
      modelOverrideFallbackOriginModel: "claude-sonnet-4-6",
    };
    const activeSessionStore = { [sessionKey]: staleAutoEntry };
    const followupRun = followupWith({
      sessionKey,
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      autoFallbackPrimaryProbe: probe,
    });
    state.runWithModelFallbackMock.mockImplementationOnce(async (params: FallbackRunnerParams) => {
      const result = await params.run(
        params.provider,
        params.model,
        initialFallbackAttemptOptions(params),
      );
      activeSessionStore[sessionKey] = {
        sessionId: "session",
        updatedAt: 2,
        providerOverride: "openai",
        modelOverride: "gpt-5.4",
        modelOverrideSource: "user",
      };
      return {
        result,
        provider: params.provider,
        model: params.model,
        attempts: [],
      };
    });
    state.runEmbeddedAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "primary recovered" }],
      meta: {
        agentMeta: {
          provider: "anthropic",
          model: "claude-sonnet-4-6",
        },
      },
    });

    await execute(
      { followupRun },
      {
        sessionKey,
        activeSessionStore,
        getActiveSessionEntry: () => staleAutoEntry,
      },
    );

    expect(activeSessionStore[sessionKey]).toMatchObject({
      providerOverride: "openai",
      modelOverride: "gpt-5.4",
      modelOverrideSource: "user",
    });
  });

  it("keeps rechecked primary probe runs in sync after live model switches", async () => {
    const probe = {
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      fallbackProvider: "openai",
      fallbackModel: "gpt-5.5",
      fallbackAuthProfileId: "openai:fallback",
      fallbackAuthProfileIdSource: "auto" as const,
    };
    const sessionEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: 1,
      providerOverride: "openai",
      modelOverride: "gpt-5.5",
      modelOverrideSource: "auto",
      modelOverrideFallbackOriginProvider: "anthropic",
      modelOverrideFallbackOriginModel: "claude-sonnet-4-6",
    };
    const sessionKey = "live-switch-probe";
    const activeSessionStore = { [sessionKey]: sessionEntry };
    const followupRun = followupWith({
      sessionKey,
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      autoFallbackPrimaryProbe: probe,
    });
    const attemptedProviders: Array<string | undefined> = [];
    state.runWithModelFallbackMock.mockImplementation(async (params: FallbackRunnerParams) => {
      attemptedProviders.push(params.provider);
      const provider = params.provider ?? "anthropic";
      const model = params.model ?? "claude-sonnet-4-6";
      return {
        result: await params.run(provider, model, initialFallbackAttemptOptions(params)),
        provider,
        model,
        attempts: [],
      };
    });
    state.runEmbeddedAgentMock
      .mockImplementationOnce(async () => {
        throw new LiveSessionModelSwitchError({
          provider: "openai",
          model: "gpt-5.4",
          authProfileId: "openai:primary",
          authProfileIdSource: "auto",
        });
      })
      .mockResolvedValueOnce({
        payloads: [{ text: "switched" }],
        meta: {
          agentMeta: {
            provider: "openai",
            model: "gpt-5.4",
          },
        },
      });

    const result = await execute(
      { followupRun },
      {
        sessionKey,
        activeSessionStore,
        getActiveSessionEntry: () => activeSessionStore[sessionKey],
      },
    );

    expect(result.kind).toBe("success");
    expect(attemptedProviders).toEqual(["anthropic", "openai"]);
    expectMockCallArgFields(state.runEmbeddedAgentMock, 1, "embedded run", {
      provider: "openai",
      model: "gpt-5.4",
      authProfileId: "openai:primary",
      authProfileIdSource: "auto",
    });
  });
});
