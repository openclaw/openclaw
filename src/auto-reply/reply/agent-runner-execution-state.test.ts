import { describe, expect, it, onTestFinished as registerTestCleanup, vi } from "vitest";
import { LiveSessionModelSwitchError } from "../../agents/live-model-switch-error.js";
import type { SessionEntry } from "../../config/sessions.js";
import {
  setupAgentRunnerExecutionTestState,
  getExecuteAgentTurnForTest,
  createFollowupRun,
  expectMockCallArgFields,
  fallbackAttemptOptions,
  initialFallbackAttemptOptions,
  createMinimalRunAgentTurnParams,
  createRunAgentTurnParams,
  useProductionEmbeddedRunExecutionParamsForTest,
} from "./agent-runner-execution.test-support.js";
import type { FallbackRunnerParams } from "./agent-runner-execution.test-support.js";

const state = await setupAgentRunnerExecutionTestState();
const executeAgentTurn = await getExecuteAgentTurnForTest();
const success = (text: string, model: string) => ({
  payloads: [{ text }],
  meta: { agentMeta: { sessionId: "session", provider: "openai", model } },
});
async function runFallback(
  params: FallbackRunnerParams,
  provider: string,
  model: string,
  options = initialFallbackAttemptOptions(params),
) {
  return { result: await params.run(provider, model, options), provider, model, attempts: [] };
}
function failPrimaryThenFallback() {
  state.runWithModelFallbackMock.mockImplementationOnce(async (params: FallbackRunnerParams) => {
    await params
      .run("anthropic", "claude-opus-4-7", initialFallbackAttemptOptions(params))
      .catch(() => undefined);
    return runFallback(params, "openai", "gpt-5.4", fallbackAttemptOptions(params, "unknown"));
  });
  state.runEmbeddedAgentMock.mockResolvedValueOnce({ payloads: [{ text: "ok" }], meta: {} });
}

describe("executeAgentTurn: session state", () => {
  const userPin = { hasSessionModelOverride: true, modelOverrideSource: "user" as const };
  const admittedDefault = { hasSessionModelOverride: false, modelOverrideSource: undefined };
  it.each([
    {
      name: "withdraws the opt-in of a user pin",
      admitted: { ...userPin, modelFallbackPolicy: "configured" as const },
      live: { ...userPin, modelFallbackPolicy: undefined },
      kind: "disabled_by_model_override",
      fallbacksOverride: [],
    },
    {
      name: "grants the opt-in to a user pin",
      admitted: { ...userPin, modelFallbackPolicy: undefined },
      live: { ...userPin, modelFallbackPolicy: "configured" as const },
      kind: "active",
      fallbacksOverride: ["openai/backup"],
    },
    {
      // A turn admitted on the default has no override flag; a later live opt-in
      // and withdrawal must not leave the default's configured chain eligible.
      name: "withdraws the opt-in from a turn admitted on the default",
      admitted: { ...admittedDefault, modelFallbackPolicy: "configured" as const },
      live: { ...userPin, modelFallbackPolicy: undefined },
      kind: "disabled_by_model_override",
      fallbacksOverride: [],
    },
    {
      name: "returns an opted-in user pin to the default",
      admitted: { ...userPin, modelFallbackPolicy: "configured" as const },
      live: { ...admittedDefault, modelFallbackPolicy: undefined },
      kind: "active",
      fallbacksOverride: undefined,
    },
  ])(
    "retries with the live selection when it $name",
    async ({ admitted, live, kind, fallbacksOverride }) => {
      await useProductionEmbeddedRunExecutionParamsForTest();
      const { resolveModelFallbackOptions } = await import("./agent-runner-run-params.js");
      const { resolveModelFallbackOptions: mockedResolver } =
        await import("./agent-runner-utils.js");
      const resolver = vi.mocked(mockedResolver);
      const previousResolver = resolver.getMockImplementation();
      resolver.mockImplementation(resolveModelFallbackOptions);
      registerTestCleanup(() => {
        if (previousResolver) {
          resolver.mockImplementation(previousResolver);
        }
      });
      state.runEmbeddedAgentMock
        .mockRejectedValueOnce(
          new LiveSessionModelSwitchError({
            provider: "anthropic",
            model: "claude",
            ...live,
          }),
        )
        .mockResolvedValueOnce({ payloads: [{ text: "switched" }], meta: {} });
      const followupRun = createFollowupRun();
      followupRun.run.hasSessionModelOverride = admitted.hasSessionModelOverride;
      followupRun.run.modelOverrideSource = admitted.modelOverrideSource;
      followupRun.run.modelFallbackPolicy = admitted.modelFallbackPolicy;
      followupRun.run.config = {
        agents: {
          defaults: {
            model: {
              primary: "anthropic/claude",
              fallbacks: ["openai/backup"],
            },
          },
        },
      };
      const result = await executeAgentTurn(createRunAgentTurnParams(followupRun));
      expect(result.kind).toBe("success");
      expect(followupRun.run.hasSessionModelOverride).toBe(live.hasSessionModelOverride);
      expect(followupRun.run.modelOverrideSource).toBe(live.modelOverrideSource);
      expect(followupRun.run.modelFallbackPolicy).toBe(live.modelFallbackPolicy);
      const retry = state.runEmbeddedAgentMock.mock.calls[1]?.[0];
      expect(retry?.modelFallbackPolicy).toBe(live.modelFallbackPolicy);
      expect(retry?.modelFallbackAvailability.kind).toBe(kind);
      expect(state.runWithModelFallbackMock.mock.calls[1]?.[0].fallbacksOverride).toEqual(
        fallbacksOverride,
      );
    },
  );

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
      .mockImplementationOnce(async () => {
        throw new LiveSessionModelSwitchError({
          provider: "openai",
          model: "gpt-5.6-luna",
          agentRuntimeOverride: "codex",
        });
      })
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
    expect(state.runEmbeddedAgentMock).toHaveBeenCalledTimes(2);
    expect(followupRun.run).toMatchObject({ provider: "openai", model: "gpt-5.6-luna" });
    expect(state.runEmbeddedAgentMock.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({ agentHarnessRuntimeOverride: "codex", thinkLevel: "ultra" }),
    );
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
      .mockImplementationOnce(async () => {
        throw new LiveSessionModelSwitchError({
          provider: "openai",
          model: "gpt-5.4",
          authProfileId: "profile-b",
          authProfileIdSource: "user",
        });
      })
      .mockImplementationOnce(async () => {
        throw new LiveSessionModelSwitchError({
          provider: "openai",
          model: "gpt-5.4",
          authProfileId: "profile-c",
          authProfileIdSource: "auto",
        });
      })
      .mockResolvedValueOnce(success("finally ok", "gpt-5.4"));

    const followupRun = createFollowupRun();
    const result = await executeAgentTurn(createRunAgentTurnParams(followupRun));

    expect(result.kind).toBe("success");
    expect(state.runEmbeddedAgentMock).toHaveBeenCalledTimes(3);
    expect(followupRun.run).toMatchObject({
      provider: "openai",
      model: "gpt-5.4",
      authProfileId: "profile-c",
      authProfileIdSource: "auto",
    });
    expect(state.runEmbeddedAgentEntryMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        selection: expect.objectContaining({ userLockedAuthProfileId: "profile-b" }),
      }),
      expect.any(Function),
    );
    expect(state.runEmbeddedAgentEntryMock).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        selection: expect.objectContaining({ userLockedAuthProfileId: undefined }),
      }),
      expect.any(Function),
    );
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
    expect(sessionStore.main).toMatchObject({ providerOverride: "zai", modelOverride: "glm-5" });
  });

  it("defers the first embedded assistant error after a CLI fallback failure", async () => {
    state.isCliProviderMock.mockImplementation((provider: unknown) => provider === "anthropic");
    failPrimaryThenFallback();
    state.runCliAgentMock.mockRejectedValueOnce(new Error("cli failed"));

    await executeAgentTurn(createMinimalRunAgentTurnParams());

    expect(state.runCliAgentMock).toHaveBeenCalledOnce();
    expect(state.runEmbeddedAgentMock).toHaveBeenCalledOnce();
    expectMockCallArgFields(state.runEmbeddedAgentMock, 0, "embedded fallback candidate", {
      assistantErrorTranscript: expect.objectContaining({
        record: expect.any(Function),
        settle: expect.any(Function),
      }),
    });
  });

  it("latches queued user message persistence across main reply fallback candidates", async () => {
    state.runEmbeddedAgentMock.mockImplementationOnce(
      async (args: {
        onUserMessagePersisted?: (m: {
          role: "user";
          content: Array<{ type: "text"; text: string }>;
        }) => void;
      }) => {
        args.onUserMessagePersisted?.({
          role: "user",
          content: [{ type: "text", text: "queued" }],
        });
        throw new Error("upstream 500");
      },
    );
    failPrimaryThenFallback();

    await executeAgentTurn(createMinimalRunAgentTurnParams());

    expect(state.runEmbeddedAgentMock).toHaveBeenCalledTimes(2);
    expectMockCallArgFields(state.runEmbeddedAgentMock, 0, "primary candidate", {
      suppressNextUserMessagePersistence: false,
    });
    expectMockCallArgFields(state.runEmbeddedAgentMock, 1, "fallback candidate", {
      suppressNextUserMessagePersistence: true,
    });
  });
});
