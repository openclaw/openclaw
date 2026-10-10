import { describe, expect, it, vi } from "vitest";
import { testing as cliBackendsTesting } from "../../agents/cli-backends.test-support.js";
import type { SessionEntry } from "../../config/sessions.js";
import type { TemplateContext } from "../templating.js";
import {
  setupAgentRunnerExecutionTestState,
  getExecuteAgentTurnForTest,
  createFollowupRun,
  initialFallbackAttemptOptions,
  requireRecord,
  requireMockCall,
  expectMockCallArgFields,
  createMinimalRunAgentTurnParams,
  useProductionEmbeddedRunExecutionParamsForTest,
} from "./agent-runner-execution.test-support.js";
import type { FallbackRunnerParams } from "./agent-runner-execution.test-support.js";

const loadProviderScopedThinkingCatalog = vi.hoisted(() => vi.fn());

vi.mock("../../agents/model-catalog.runtime.js", () => ({
  loadProviderScopedThinkingCatalog,
}));

const state = await setupAgentRunnerExecutionTestState();

describe("executeAgentTurn: runtime selection", () => {
  it.each([
    {
      provider: "openai",
      model: "gpt-5.6-luna",
      api: "openai-chatgpt-responses" as const,
      baseUrl: "https://chatgpt.com/backend-api/codex",
      agentRuntime: "codex",
      runtimeOverride: "codex",
      thinkLevel: "max" as const,
    },
  ])(
    "prepares $provider thinking capability for the concrete $agentRuntime runtime",
    async ({ provider, model, api, baseUrl, agentRuntime, runtimeOverride, thinkLevel }) => {
      await useProductionEmbeddedRunExecutionParamsForTest();
      const compat = { supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max"] };
      const catalogEntry = {
        provider,
        id: model,
        name: model,
        api,
        baseUrl,
        reasoning: true,
        input: ["text" as const],
        compat,
      };
      loadProviderScopedThinkingCatalog.mockResolvedValue([catalogEntry]);
      state.runWithModelFallbackMock.mockImplementationOnce(
        async (params: FallbackRunnerParams) => ({
          result: await params.run(provider, model, initialFallbackAttemptOptions(params)),
          provider,
          model,
          attempts: [],
        }),
      );
      state.runEmbeddedAgentMock.mockResolvedValueOnce({ payloads: [{ text: "final" }], meta: {} });
      const followupRun = createFollowupRun();
      followupRun.run.provider = provider;
      followupRun.run.model = model;
      followupRun.run.thinkLevel = thinkLevel;
      followupRun.run.skipProviderRuntimeHints = true;
      followupRun.run.thinkingCatalog = [catalogEntry];
      followupRun.run.config = {
        models: { providers: { [provider]: { api, baseUrl, models: [] } } },
      };
      const executeAgentTurn = await getExecuteAgentTurnForTest();

      const result = await executeAgentTurn({
        ...createMinimalRunAgentTurnParams({ followupRun }),
        getActiveSessionEntry: () => ({
          sessionId: "session",
          updatedAt: 1,
          agentRuntimeOverride: runtimeOverride,
        }),
      });

      expect(result.kind).toBe("success");
      expectMockCallArgFields(state.runEmbeddedAgentMock, 0, "embedded thinking params", {
        thinkLevel,
        modelThinkingCapability: {
          provider,
          modelId: model,
          agentRuntime,
          compat,
        },
      });
      expect(loadProviderScopedThinkingCatalog).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ provider, model, agentRuntime: "codex" }),
      );
    },
  );

  it.each(["group"] as const)(
    "forwards authoritative %s type through CLI fallback for opaque session keys",
    async (chatType) => {
      state.isCliProviderMock.mockReturnValue(true);
      state.runWithModelFallbackMock.mockImplementationOnce(
        async (params: FallbackRunnerParams) => ({
          result: await params.run("codex-cli", "gpt-5.4", initialFallbackAttemptOptions(params)),
          provider: "codex-cli",
          model: "gpt-5.4",
          attempts: [],
        }),
      );
      state.runCliAgentMock.mockResolvedValueOnce({
        payloads: [{ text: "final" }],
        meta: {},
      });

      const executeAgentTurn = await getExecuteAgentTurnForTest();
      const followupRun = createFollowupRun();
      followupRun.run.agentId = "main";
      followupRun.run.provider = "codex-cli";
      followupRun.run.model = "gpt-5.4";
      followupRun.run.sessionKey = "agent:main:opaque:binding";
      followupRun.run.chatType = chatType;

      await executeAgentTurn({
        ...createMinimalRunAgentTurnParams({
          followupRun,
          sessionCtx: {
            Provider: "discord",
            MessageSid: "msg",
          } as unknown as TemplateContext,
        }),
        sessionKey: "agent:main:opaque:binding",
      });

      expectMockCallArgFields(state.runCliAgentMock, 0, "CLI run params", {
        sessionKey: "agent:main:opaque:binding",
        chatType,
      });
    },
  );

  it("prefers normalized current shared context over stale queued direct metadata", async () => {
    state.isCliProviderMock.mockReturnValue(true);
    state.runWithModelFallbackMock.mockImplementationOnce(async (params: FallbackRunnerParams) => ({
      result: await params.run("codex-cli", "gpt-5.4", initialFallbackAttemptOptions(params)),
      provider: "codex-cli",
      model: "gpt-5.4",
      attempts: [],
    }));
    state.runCliAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "final" }],
      meta: {},
    });

    const executeAgentTurn = await getExecuteAgentTurnForTest();
    const followupRun = createFollowupRun();
    followupRun.run.agentId = "main";
    followupRun.run.provider = "codex-cli";
    followupRun.run.model = "gpt-5.4";
    followupRun.run.sessionKey = "agent:main:opaque:binding";
    followupRun.run.chatType = "direct";

    await executeAgentTurn({
      ...createMinimalRunAgentTurnParams({
        followupRun,
        sessionCtx: {
          Provider: "discord",
          ChatType: "Channel",
          MessageSid: "msg",
        } as unknown as TemplateContext,
      }),
      sessionKey: "agent:main:opaque:binding",
    });

    expectMockCallArgFields(state.runCliAgentMock, 0, "CLI run params", {
      sessionKey: "agent:main:opaque:binding",
      chatType: "channel",
    });
  });

  it("does not pass CLI runtime overrides as embedded harness ids for fallback providers", async () => {
    cliBackendsTesting.setDepsForTest({
      resolveRuntimeCliBackends: () => [],
      resolvePluginSetupCliBackend: ({ backend, config }) =>
        backend === "claude-cli" && config
          ? {
              pluginId: "anthropic",
              backend: {
                id: "claude-cli",
                modelProvider: "anthropic",
                config: { command: "claude" },
                bundleMcp: false,
              },
            }
          : undefined,
    });
    state.isCliProviderMock.mockImplementation((provider: unknown) => provider === "claude-cli");
    state.runWithModelFallbackMock.mockImplementationOnce(async (params: FallbackRunnerParams) => ({
      result: await params.run("openai", "gpt-5.4", initialFallbackAttemptOptions(params)),
      provider: "openai",
      model: "gpt-5.4",
      attempts: [],
    }));
    state.runEmbeddedAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "fallback" }],
      meta: {},
    });

    const executeAgentTurn = await getExecuteAgentTurnForTest();
    const followupRun = createFollowupRun();
    followupRun.run.provider = "anthropic";
    followupRun.run.model = "claude-opus-4-7";
    followupRun.run.config = {
      agents: {
        defaults: {
          models: { "anthropic/claude-opus-4-7": { agentRuntime: { id: "claude-cli" } } },
        },
      },
    };

    const result = await executeAgentTurn({
      ...createMinimalRunAgentTurnParams({ followupRun }),
      getActiveSessionEntry: () =>
        ({
          sessionId: "session",
          updatedAt: Date.now(),
          agentRuntimeOverride: "claude-cli",
        }) as SessionEntry,
    });

    expect(result.kind).toBe("success");
    expect(state.runCliAgentMock).not.toHaveBeenCalled();
    expect(state.runEmbeddedAgentMock).toHaveBeenCalledOnce();
    expect(
      requireRecord(
        requireMockCall(state.runEmbeddedAgentMock, 0, "embedded run params")[0],
        "embedded run params",
      ),
    ).not.toHaveProperty("agentHarnessId", "claude-cli");
  });

  it("keeps plugin-owned CLI turns on the CLI path after observing that runtime", async () => {
    cliBackendsTesting.setDepsForTest({
      resolveRuntimeCliBackends: () => [
        {
          id: "claude-cli",
          modelProvider: "anthropic",
          pluginId: "anthropic",
          config: { command: "claude" },
        },
      ],
    });
    state.isCliProviderMock.mockImplementation((provider: unknown) => provider === "claude-cli");
    state.runWithModelFallbackMock.mockImplementationOnce(async (params: FallbackRunnerParams) => ({
      result: await params.run(
        "anthropic",
        "claude-sonnet-4-6",
        initialFallbackAttemptOptions(params),
      ),
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      attempts: [],
    }));
    state.runCliAgentMock.mockResolvedValueOnce({ payloads: [{ text: "continued" }], meta: {} });
    const followupRun = createFollowupRun();
    followupRun.run.provider = "anthropic";
    followupRun.run.model = "claude-sonnet-4-6";
    followupRun.run.modelSelectionLocked = true;
    // Modality preparation looks up the canonical model, not the CLI backend alias.
    followupRun.run.thinkingCatalog = [
      { provider: "anthropic", id: "claude-sonnet-4-6", input: ["text", "image"] },
    ];
    const executeAgentTurn = await getExecuteAgentTurnForTest();

    await executeAgentTurn({
      ...createMinimalRunAgentTurnParams({ followupRun }),
      getActiveSessionEntry: () => ({
        sessionId: "session",
        updatedAt: 1,
        modelSelectionLocked: true,
        pluginOwnerId: "cli-owner",
        agentRuntimeOverride: "claude-cli",
        agentHarnessId: "claude-cli",
      }),
    });

    expect(state.runEmbeddedAgentMock).not.toHaveBeenCalled();
    expectMockCallArgFields(state.runCliAgentMock, 0, "CLI run params", {
      provider: "claude-cli",
      model: "claude-sonnet-4-6",
      modelHasVision: true,
    });
  });
});
