import { describe, expect, it, vi } from "vitest";
import { LiveSessionModelSwitchError } from "../../agents/live-model-switch-error.js";
import type { SessionEntry } from "../../config/sessions.js";
import type { TemplateContext } from "../templating.js";
import {
  createAgentTurnExecutionDefaults,
  setupAgentRunnerExecutionTestState,
  getExecuteAgentTurnForTest,
  createMockTypingSignaler,
  createFollowupRun,
  expectMockCallArgFields,
  fallbackAttemptOptions,
  initialFallbackAttemptOptions,
  createMinimalRunAgentTurnParams,
  createRunAgentTurnParams,
} from "./agent-runner-execution.test-support.js";
import type { FallbackRunnerParams } from "./agent-runner-execution.test-support.js";

const state = await setupAgentRunnerExecutionTestState();

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
    const executeAgentTurn = await getExecuteAgentTurnForTest();
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
          model: "gpt-5.6-luna",
          agentRuntimeOverride: "codex",
        });
      })
      .mockImplementationOnce(async () => {
        return {
          payloads: [{ text: "switched" }],
          meta: {
            agentMeta: {
              sessionId: "session",
              provider: "openai",
              model: "gpt-5.6-luna",
            },
          },
        };
      });

    const executeAgentTurn = await getExecuteAgentTurnForTest();
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
    expect(followupRun.run.provider).toBe("openai");
    expect(followupRun.run.model).toBe("gpt-5.6-luna");
    expect(state.runEmbeddedAgentMock.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({ agentHarnessRuntimeOverride: "codex", thinkLevel: "ultra" }),
    );
  });

  it("propagates auth profile state on bounded live model switch retries (#58348)", async () => {
    let invocation = 0;
    state.runWithModelFallbackMock.mockImplementation(async (params: FallbackRunnerParams) => {
      invocation++;
      if (invocation <= 2) {
        return {
          result: await params.run(
            "anthropic",
            "claude",
            invocation === 1
              ? initialFallbackAttemptOptions(params)
              : fallbackAttemptOptions(params, "unknown"),
          ),
          provider: "anthropic",
          model: "claude",
          attempts: [],
        };
      }
      // Third invocation succeeds with the switched model
      return {
        result: await params.run("openai", "gpt-5.4", initialFallbackAttemptOptions(params)),
        provider: "openai",
        model: "gpt-5.4",
        attempts: [],
      };
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
      .mockImplementationOnce(async () => {
        return {
          payloads: [{ text: "finally ok" }],
          meta: {
            agentMeta: {
              sessionId: "session",
              provider: "openai",
              model: "gpt-5.4",
            },
          },
        };
      });

    const executeAgentTurn = await getExecuteAgentTurnForTest();
    const followupRun = createFollowupRun();
    const result = await executeAgentTurn(createRunAgentTurnParams(followupRun));

    // Two switches (within the limit of 2) then success on third attempt
    expect(result.kind).toBe("success");
    expect(state.runEmbeddedAgentMock).toHaveBeenCalledTimes(3);
    expect(followupRun.run.provider).toBe("openai");
    expect(followupRun.run.model).toBe("gpt-5.4");
    expect(followupRun.run.authProfileId).toBe("profile-c");
    expect(followupRun.run.authProfileIdSource).toBe("auto");
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
      getActiveSessionEntry: () => sessionEntry,
      activeSessionStore: sessionStore,
      resolvedVerboseLevel: "off",
    });

    expect(result.kind).toBe("final");
    expect(sessionEntry.providerOverride).toBe("zai");
    expect(sessionEntry.modelOverride).toBe("glm-5");
    expect(sessionEntry.authProfileOverride).toBe("zai:work");
    expect(sessionEntry.authProfileOverrideSource).toBe("user");
    expect(sessionStore.main.providerOverride).toBe("zai");
    expect(sessionStore.main.modelOverride).toBe("glm-5");
  });

  it("defers the first embedded assistant error after a CLI fallback failure", async () => {
    state.isCliProviderMock.mockImplementation((provider: unknown) => provider === "anthropic");
    state.runWithModelFallbackMock.mockImplementationOnce(async (params: FallbackRunnerParams) => {
      await params
        .run("anthropic", "claude-opus-4-7", initialFallbackAttemptOptions(params))
        .catch(() => undefined);
      return {
        result: await params.run("openai", "gpt-5.4", fallbackAttemptOptions(params, "unknown")),
        provider: "openai",
        model: "gpt-5.4",
        attempts: [],
      };
    });
    state.runCliAgentMock.mockRejectedValueOnce(new Error("cli failed"));
    state.runEmbeddedAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "ok" }],
      meta: {},
    });

    const executeAgentTurn = await getExecuteAgentTurnForTest();
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
    state.runWithModelFallbackMock.mockImplementationOnce(async (params: FallbackRunnerParams) => {
      await params
        .run("anthropic", "claude-opus-4-7", initialFallbackAttemptOptions(params))
        .catch(() => undefined);
      return {
        result: await params.run("openai", "gpt-5.4", fallbackAttemptOptions(params, "unknown")),
        provider: "openai",
        model: "gpt-5.4",
        attempts: [],
      };
    });
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
    state.runEmbeddedAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "ok" }],
      meta: {},
    });

    const executeAgentTurn = await getExecuteAgentTurnForTest();
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
