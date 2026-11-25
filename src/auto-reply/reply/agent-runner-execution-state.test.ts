import { describe, expect, it, vi } from "vitest";
import type { RunEmbeddedAgentParams } from "../../agents/embedded-agent-runner/run/params.js";
import { LiveSessionModelSwitchError } from "../../agents/live-model-switch-error.js";
import type { SessionEntry } from "../../config/sessions.js";
import {
  createRunResult,
  runFallbackCandidate as runFallback,
  setupAgentRunnerExecutionTestState,
  getExecuteAgentTurnForTest,
  createFollowupRun,
  expectMockCallArgFields,
  fallbackAttemptOptions,
  initialFallbackAttemptOptions,
  createMinimalRunAgentTurnParams,
  createRunAgentTurnParams,
} from "./agent-runner-execution.test-support.js";
import type { FallbackRunnerParams } from "./agent-runner-execution.test-support.js";

const state = await setupAgentRunnerExecutionTestState();
const executeAgentTurn = await getExecuteAgentTurnForTest();
const success = (text: string, model: string) => ({
  payloads: [{ text }],
  meta: { agentMeta: { sessionId: "session", provider: "openai", model } },
});
const switchModel = (
  selection: Partial<ConstructorParameters<typeof LiveSessionModelSwitchError>[0]>,
) => new LiveSessionModelSwitchError({ provider: "openai", model: "gpt-5.4", ...selection });
function failPrimaryThenFallback() {
  state.runWithModelFallbackMock.mockImplementationOnce(async (params: FallbackRunnerParams) => {
    await params
      .run("anthropic", "claude-opus-4-7", initialFallbackAttemptOptions(params))
      .catch(() => undefined);
    return runFallback(params, "openai", "gpt-5.4", fallbackAttemptOptions(params, "unknown"));
  });
  state.runEmbeddedAgentMock.mockResolvedValueOnce(createRunResult("ok"));
}

describe("executeAgentTurn: session state", () => {
  it("settles spawned children under the conversation identity while preserving peer policy", async ({
    onTestFinished,
  }) => {
    const subagentRegistry = await import("../../agents/subagents/registry/subagent-registry.js");
    const { resolveModelFallbackOptions } = await import("./agent-runner-run-params.js");
    const { resolveModelFallbackOptions: resolveFallbackOptionsForTest } =
      await import("./agent-runner-utils.js");
    const resolver = vi.mocked(resolveFallbackOptionsForTest);
    const previousResolver = resolver.getMockImplementation();
    resolver.mockImplementation(resolveModelFallbackOptions);
    onTestFinished(() => {
      if (previousResolver) {
        resolver.mockImplementation(previousResolver);
      }
    });
    const settle = vi
      .spyOn(subagentRegistry, "settleRequesterAfterSessionSpawns")
      .mockResolvedValue(true);
    onTestFinished(() => settle.mockRestore());
    state.runEmbeddedAgentEntryMock.mockImplementation(async (params, delegate) => {
      await params.preparedRunAdmission.admit("embedded");
      return delegate(params);
    });
    const followupRun = createFollowupRun();
    const policyKey = "agent:main:whatsapp:default:direct:qa-peer";
    followupRun.run.runtimePolicySessionKey = policyKey;
    const acceptedSessionSpawns = [
      {
        runId: "qa-child",
        childSessionKey: "agent:main:subagent:qa-child",
        expectsCompletionMessage: true,
      },
    ];
    state.runEmbeddedAgentMock.mockResolvedValue({
      payloads: [{ text: "Child started." }],
      acceptedSessionSpawns,
      meta: {},
    });
    const result = await executeAgentTurn(createRunAgentTurnParams(followupRun));

    expect(result.kind).toBe("success");
    expect(settle).toHaveBeenCalledExactlyOnceWith({
      requesterSessionKey: "main",
      requesterAgentId: "main",
      requesterTurnRunId: expect.any(String),
      requesterYielded: false,
      acceptedSessionSpawns,
      assertCurrent: expect.any(Function),
    });
    expect(state.runEmbeddedAgentEntryMock.mock.calls[0]?.[0].harness.sessionKey).toBe(policyKey);
  });

  it("keeps thinking paired with the winning runtime when a live model switch restarts the prompt", async () => {
    let fallbackInvocation = 0;
    state.runWithModelFallbackMock.mockImplementation(async (params: FallbackRunnerParams) => {
      const isInitialInvocation = fallbackInvocation++ === 0;
      const provider = isInitialInvocation ? "anthropic" : "openai";
      const model = isInitialInvocation ? "claude" : "gpt-5.6-luna";
      return runFallback(params, provider, model);
    });
    state.runEmbeddedAgentMock
      .mockRejectedValueOnce(
        switchModel({
          model: "gpt-5.6-luna",
          agentRuntimeOverride: "codex",
        }),
      )
      .mockResolvedValueOnce(success("switched", "gpt-5.6-luna"));

    const followupRun = createFollowupRun();
    followupRun.run.thinkLevel = "ultra";
    followupRun.run.thinkingCatalog?.push({
      provider: "openai",
      id: "gpt-5.6-luna",
      input: ["text"],
      reasoning: true,
      compat: { supportedReasoningEfforts: ["medium", "high", "max"] },
    });
    const staleEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: 1,
      agentRuntimeOverride: "openclaw",
    };
    const result = await executeAgentTurn({
      ...createRunAgentTurnParams(followupRun),
      getActiveSessionEntry: () => staleEntry,
    });

    expect(result.kind).toBe("success");
    expect(followupRun.run).toMatchObject({ provider: "openai", model: "gpt-5.6-luna" });
    expect(state.runEmbeddedAgentMock.mock.calls[1]?.[0]).toMatchObject({
      agentHarnessRuntimeOverride: "codex",
      thinkLevel: "ultra",
    });
  });

  it("propagates auth profile state on bounded live model switch retries (#58348)", async () => {
    let invocation = 0;
    state.runWithModelFallbackMock.mockImplementation(async (params: FallbackRunnerParams) => {
      invocation++;
      if (invocation <= 2) {
        return runFallback(
          params,
          "anthropic",
          "claude",
          invocation === 1
            ? initialFallbackAttemptOptions(params)
            : fallbackAttemptOptions(params, "unknown"),
        );
      }
      return runFallback(params, "openai", "gpt-5.4");
    });
    state.runEmbeddedAgentMock
      .mockRejectedValueOnce(
        switchModel({ authProfileId: "profile-b", authProfileIdSource: "user" }),
      )
      .mockRejectedValueOnce(
        switchModel({ authProfileId: "profile-c", authProfileIdSource: "auto" }),
      )
      .mockResolvedValueOnce(success("finally ok", "gpt-5.4"));

    const followupRun = createFollowupRun();
    const result = await executeAgentTurn(createRunAgentTurnParams(followupRun));

    expect(result.kind).toBe("success");
    expect(followupRun.run).toMatchObject({
      provider: "openai",
      model: "gpt-5.4",
      authProfileId: "profile-c",
      authProfileIdSource: "auto",
    });
    expect(
      state.runEmbeddedAgentEntryMock.mock.calls
        .slice(1)
        .map(([entry]) => entry.selection.userLockedAuthProfileId),
    ).toEqual(["profile-b", undefined]);
  });

  it("does not roll back newer override changes after a failed fallback candidate", async () => {
    state.runWithModelFallbackMock.mockImplementation(async (params: FallbackRunnerParams) => {
      await expect(
        params.run("openai", "gpt-5.4", fallbackAttemptOptions(params, "unknown")),
      ).rejects.toThrow("fallback failed");
      throw new Error("fallback failed");
    });
    const sessionEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
      providerOverride: "anthropic",
      modelOverride: "claude",
      authProfileOverride: "anthropic:default",
      authProfileOverrideSource: "user",
    };
    const sessionStore = { main: sessionEntry };
    state.runEmbeddedAgentMock.mockImplementationOnce(async () => {
      sessionEntry.providerOverride = "zai";
      sessionEntry.modelOverride = "glm-5";
      sessionEntry.authProfileOverride = "zai:work";
      sessionEntry.authProfileOverrideSource = "user";
      throw new Error("fallback failed");
    });

    const result = await executeAgentTurn({
      ...createMinimalRunAgentTurnParams(),
      commandBody: "hello",
      getActiveSessionEntry: () => sessionEntry,
      activeSessionStore: sessionStore,
    });

    expect(result.kind).toBe("final");
    expect(sessionEntry).toMatchObject({
      providerOverride: "zai",
      modelOverride: "glm-5",
      authProfileOverride: "zai:work",
      authProfileOverrideSource: "user",
    });
  });

  it("latches queued user message persistence across main reply fallback candidates", async () => {
    state.runEmbeddedAgentMock.mockImplementationOnce(async (args: RunEmbeddedAgentParams) => {
      args.onUserMessagePersisted?.({
        role: "user",
        content: [{ type: "text", text: "queued" }],
        timestamp: 0,
      });
      throw new Error("upstream 500");
    });
    failPrimaryThenFallback();

    await executeAgentTurn(createMinimalRunAgentTurnParams());

    expectMockCallArgFields(state.runEmbeddedAgentMock, 0, "primary candidate", {
      suppressNextUserMessagePersistence: false,
    });
    expectMockCallArgFields(state.runEmbeddedAgentMock, 1, "fallback candidate", {
      suppressNextUserMessagePersistence: true,
    });
  });
});
