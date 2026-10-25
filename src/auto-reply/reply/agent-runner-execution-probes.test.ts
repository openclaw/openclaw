import { describe, expect, it, onTestFinished, vi } from "vitest";
import { createCliTimeoutError } from "../../agents/cli-runner/no-output-timeout-policy.js";
import { LiveSessionModelSwitchError } from "../../agents/live-model-switch-error.js";
import type { SessionEntry } from "../../config/sessions.js";
import { withSessionControllerOwner } from "../../sessions/session-controller.context.js";
import { createReplyOperation } from "../../sessions/session-controller.js";
import { resolveRunAfterAutoFallbackPrimaryProbeRecheck } from "./agent-runner-auto-fallback.js";
import {
  setupAgentRunnerExecutionTestState,
  getExecuteAgentTurnForTest,
  createFollowupRun,
  createRunResult,
  runFallbackCandidate,
  fallbackAttemptOptions,
  initialFallbackAttemptOptions,
  createMockReplyOperation,
  expectMockCallArgFields,
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

type Probe = NonNullable<ReturnType<typeof createFollowupRun>["run"]["autoFallbackPrimaryProbe"]>;

function createProbe(overrides: Partial<Probe> = {}): Probe {
  return {
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    fallbackProvider: "google",
    fallbackModel: "gemini-3-pro",
    ...overrides,
  };
}

function createSessionEntry(overrides: Partial<SessionEntry> = {}): SessionEntry {
  return { sessionId: "session", updatedAt: 1, ...overrides };
}

function createProbeRun(overrides: Partial<ReturnType<typeof createFollowupRun>["run"]> = {}) {
  const probe = createProbe();
  return createFollowupRun({
    provider: probe.provider,
    model: probe.model,
    autoFallbackPrimaryProbe: probe,
    ...overrides,
  });
}

function createFallbackSelection(probe = createProbe()) {
  return createSessionEntry({
    providerOverride: probe.fallbackProvider,
    modelOverride: probe.fallbackModel,
    modelOverrideSource: "auto",
    modelOverrideFallbackOriginProvider: probe.provider,
    modelOverrideFallbackOriginModel: probe.model,
  });
}

function storedProbe(entry: SessionEntry, followupRun = createProbeRun(), sessionKey = "main") {
  const store: Record<string, SessionEntry> = { [sessionKey]: entry };
  return {
    store,
    followupRun,
    execute: (overrides: Partial<AgentTurnParams> = {}) =>
      execute(
        { followupRun },
        { sessionKey, activeSessionStore: store, getActiveSessionEntry: () => entry, ...overrides },
      ),
  };
}

function routeResult(text: string, provider: string, model: string) {
  return createRunResult(text, {
    durationMs: 1,
    agentMeta: { sessionId: "session", provider, model },
  });
}

function recheck(run: ReturnType<typeof createFollowupRun>["run"], entry: SessionEntry) {
  return resolveRunAfterAutoFallbackPrimaryProbeRecheck({ run, entry, sessionKey: "main" });
}

function lifecycleEvents(runId: string) {
  return vi
    .mocked(emitAgentEvent)
    .mock.calls.map(([event]) => event)
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
    const followupRun = createFollowupRun({
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
    state.runWithModelFallbackMock.mockImplementationOnce(runFallbackCandidate);
    state.runEmbeddedAgentMock.mockResolvedValue(createRunResult("ok"));
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
    const probe = createProbe({
      fallbackAuthProfileId: "google:fallback",
      fallbackAuthProfileIdSource: "auto",
    });
    markAutoFallbackPrimaryProbe({
      probe,
      sessionKey: "main",
    });
    const sessionEntry = createSessionEntry({
      providerOverride: "google",
      modelOverride: "gemini-3-pro",
      modelOverrideSource: "auto",
      modelOverrideFallbackOriginProvider: "anthropic",
      modelOverrideFallbackOriginModel: "claude-sonnet-4-6",
      authProfileOverride: "google:fallback",
      authProfileOverrideSource: "auto",
    });
    const { run } = createProbeRun({
      authProfileId: "anthropic:primary",
      authProfileIdSource: "auto",
      autoFallbackPrimaryProbe: probe,
    });

    expect(recheck(run, sessionEntry)).toMatchObject({
      provider: "google",
      model: "gemini-3.1-pro-preview",
      requestedRouteResolution: "resolved",
      authProfileId: "google:fallback",
      authProfileIdSource: "auto",
      autoFallbackPrimaryProbe: undefined,
    });
  });

  it.each([
    { providerOverride: "openai", modelOverride: "gpt-5.4" },
    { providerOverride: undefined, modelOverride: "openai/gpt-5.4" },
  ])("propagates rechecked user selection $modelOverride to post-run state", async (selection) => {
    const sessionKey = "rechecked-user-selection";
    const sessionEntry = createSessionEntry({
      ...selection,
      modelOverrideSource: "user",
      authProfileOverride: "openai:work",
      authProfileOverrideSource: "user",
    });
    const staleAutoEntry = createFallbackSelection();
    const fixture = storedProbe(sessionEntry, createProbeRun(), sessionKey);
    state.runWithModelFallbackMock.mockImplementationOnce(runFallbackCandidate);
    state.runEmbeddedAgentMock.mockResolvedValueOnce(
      routeResult("user model", "openai", "gpt-5.4"),
    );

    await fixture.execute({ getActiveSessionEntry: () => staleAutoEntry });

    expect(fixture.followupRun.run).toMatchObject({
      provider: "openai",
      model: "gpt-5.4",
      requestedRouteResolution: "raw",
      authProfileId: "openai:work",
      authProfileIdSource: "user",
      modelOverrideSource: "user",
    });
    expect(fixture.followupRun.run.autoFallbackPrimaryProbe).toBeUndefined();
    expect(fixture.store[sessionKey]).toMatchObject({
      ...selection,
      modelOverrideSource: "user",
    });
  });

  it("drops stale queued probe metadata after the auto fallback pin is cleared", () => {
    const probe = createProbe();
    const sessionEntry = createSessionEntry({
      authProfileOverride: "google:fallback",
      authProfileOverrideSource: "user",
    });
    const { run } = createProbeRun({
      hasSessionModelOverride: true,
      modelOverrideSource: "auto",
      hasAutoFallbackProvenance: true,
      autoFallbackPrimaryProbe: probe,
    });

    const rechecked = recheck(run, sessionEntry);
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
    const probe = createProbe({
      fallbackAuthProfileId: "google:fallback",
      fallbackAuthProfileIdSource: "auto",
    });
    const followupRun = createProbeRun({ autoFallbackPrimaryProbe: probe });
    const sessionKey = "exhausted-primary-probe";
    const sessionEntry = {
      ...createFallbackSelection(probe),
      authProfileOverride: probe.fallbackAuthProfileId,
      authProfileOverrideSource: "auto" as const,
    };
    const fixture = storedProbe(sessionEntry, followupRun, sessionKey);
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
    const result = await fixture.execute({
      replyOperation,
      getActiveSessionEntry: () => fixture.store[sessionKey],
    });

    expect(result).toMatchObject({
      kind: "success",
      fallbackExhausted: true,
      fallbackProvider: probe.provider,
      fallbackModel: probe.model,
      runResult: exhaustedResult,
    });
    expect(fixture.store[sessionKey]).toMatchObject({
      providerOverride: probe.fallbackProvider,
      modelOverride: probe.fallbackModel,
      modelOverrideSource: "auto",
      modelOverrideFallbackOriginProvider: probe.provider,
      modelOverrideFallbackOriginModel: probe.model,
    });
    expect(completeMock).not.toHaveBeenCalled();
    expect(failMock).toHaveBeenCalledWith("run_failed", expect.any(Error));
    expect(
      vi
        .mocked(emitAgentEvent)
        .mock.calls.map((call) => call[0])
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
    const followupRun = createFollowupRun({ provider: "codex-cli", model: "gpt-5.4" });
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
    expect(events).toContainEqual(
      expect.objectContaining({
        data: expect.objectContaining({ phase: "error", executionSettled: true }),
      }),
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
    const followupRun = createFollowupRun({ provider: "codex-cli", model: "gpt-5.4" });
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
    const followupRun = createFollowupRun({
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
      return createRunResult("candidate");
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
    const probe = createProbe();
    const sessionKey = "concurrent-user-switch-during-probe";
    const staleAutoEntry = createFallbackSelection();
    const followupRun = createProbeRun({ sessionKey, autoFallbackPrimaryProbe: probe });
    const fixture = storedProbe(staleAutoEntry, followupRun, sessionKey);
    state.runWithModelFallbackMock.mockImplementationOnce(async (params: FallbackRunnerParams) => {
      const result = await params.run(
        params.provider,
        params.model,
        initialFallbackAttemptOptions(params),
      );
      fixture.store[sessionKey] = {
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
    state.runEmbeddedAgentMock.mockResolvedValueOnce(
      routeResult("primary recovered", "anthropic", "claude-sonnet-4-6"),
    );

    await fixture.execute();

    expect(fixture.store[sessionKey]).toMatchObject({
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
    const sessionEntry = createSessionEntry({
      providerOverride: "openai",
      modelOverride: "gpt-5.5",
      modelOverrideSource: "auto",
      modelOverrideFallbackOriginProvider: "anthropic",
      modelOverrideFallbackOriginModel: "claude-sonnet-4-6",
    });
    const sessionKey = "live-switch-probe";
    const followupRun = createProbeRun({ sessionKey, autoFallbackPrimaryProbe: probe });
    const fixture = storedProbe(sessionEntry, followupRun, sessionKey);
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
      .mockResolvedValueOnce(routeResult("switched", "openai", "gpt-5.4"));

    const result = await fixture.execute({
      getActiveSessionEntry: () => fixture.store[sessionKey],
    });

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
