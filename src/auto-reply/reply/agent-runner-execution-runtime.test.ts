import { expect, it, vi } from "vitest";
import { testing as cliBackendsTesting } from "../../agents/cli-backends.test-support.js";
import type { TemplateContext } from "../templating.js";
import { setupExecutionSuite } from "./agent-runner-execution-suite.test-support.js";
import {
  createRunResult,
  createFollowupRun,
  runFallbackCandidate,
  requireRecord,
  requireMockCall,
  expectMockCallArgFields,
  createMinimalRunAgentTurnParams,
  useProductionEmbeddedRunExecutionParamsForTest,
} from "./agent-runner-execution.test-support.js";
import type { FallbackRunnerParams } from "./agent-runner-execution.test-support.js";

const loadProviderScopedThinkingCatalog = vi.hoisted(() => vi.fn());

// mock-isolation: Supply the thinking catalog fixture without live model discovery.
vi.mock("../../agents/model-catalog.runtime.js", () => ({ loadProviderScopedThinkingCatalog }));

const { state, runTurn } = await setupExecutionSuite();
const cliBackend = () => ({
  id: "claude-cli",
  modelProvider: "anthropic",
  config: { command: "claude" },
});

function selectFallback(provider: string, model: string) {
  state.runWithModelFallbackMock.mockImplementationOnce((params: FallbackRunnerParams) =>
    runFallbackCandidate(params, provider, model),
  );
}

function opaqueCliTurn(chatType: "group" | "direct", currentChatType?: string) {
  state.isCliProviderMock.mockReturnValue(true);
  selectFallback("codex-cli", "gpt-5.4");
  state.runCliAgentMock.mockResolvedValueOnce(createRunResult("final"));
  const followupRun = createFollowupRun({
    agentId: "main",
    provider: "codex-cli",
    model: "gpt-5.4",
    sessionKey: "agent:main:opaque:binding",
    chatType,
  });
  return {
    ...createMinimalRunAgentTurnParams({
      followupRun,
      sessionCtx: {
        Provider: "discord",
        MessageSid: "msg",
        ...(currentChatType ? { ChatType: currentChatType } : {}),
      } as unknown as TemplateContext,
    }),
    sessionKey: "agent:main:opaque:binding",
  };
}

it("prepares OpenAI thinking and forwards turn context for the concrete Codex runtime", async () => {
  const provider = "openai",
    model = "gpt-5.6-luna",
    agentRuntime = "codex";
  const api = "openai-chatgpt-responses" as const,
    baseUrl = "https://chatgpt.com/backend-api/codex";
  const thinkLevel = "max";
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
  selectFallback(provider, model);
  state.runEmbeddedAgentMock.mockResolvedValueOnce(createRunResult("final"));
  const turnContext = { start: 0, text: "Current conversation." };
  const followupRun = createFollowupRun({
    extraSystemPrompt: "Current conversation.\n\nPersistent policy.",
    extraSystemPromptTurnContext: turnContext,
    provider,
    model,
    thinkLevel,
    skipProviderRuntimeHints: true,
    thinkingCatalog: [catalogEntry],
    config: { models: { providers: { [provider]: { api, baseUrl, models: [] } } } },
  });

  const result = await runTurn({
    followupRun,
    opts: { forceRestartSafeTools: true, forceCodeModeTools: true, toolsAllow: ["message"] },
    getActiveSessionEntry: () => ({
      sessionId: "session",
      updatedAt: 1,
      agentRuntimeOverride: agentRuntime,
    }),
  });

  expect(result.kind).toBe("success");
  expectMockCallArgFields(state.runEmbeddedAgentMock, 0, "embedded thinking params", {
    thinkLevel,
    forceRestartSafeTools: true,
    forceCodeModeTools: true,
    toolsAllow: ["message"],
    modelThinkingCapability: { provider, modelId: model, agentRuntime, compat },
    extraSystemPrompt: "Current conversation.\n\nPersistent policy.",
    extraSystemPromptTurnContext: turnContext,
  });
  expect(loadProviderScopedThinkingCatalog).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ provider, model, agentRuntime: "codex" }),
  );
});

it.each([
  { queued: "group", current: undefined, expected: "group" },
  { queued: "direct", current: "Channel", expected: "channel" },
] as const)(
  "forwards authoritative $expected type over queued $queued metadata",
  async ({ queued, current, expected }) => {
    await runTurn(opaqueCliTurn(queued, current));
    expectMockCallArgFields(state.runCliAgentMock, 0, "CLI run params", {
      sessionKey: "agent:main:opaque:binding",
      chatType: expected,
    });
  },
);

it("does not pass CLI runtime overrides as embedded harness ids for fallback providers", async () => {
  cliBackendsTesting.setDepsForTest({
    resolveRuntimeCliBackends: () => [],
    resolvePluginSetupCliBackend: ({ backend, config }) =>
      backend === "claude-cli" && config
        ? {
            pluginId: "anthropic",
            backend: { ...cliBackend(), bundleMcp: false },
          }
        : undefined,
  });
  state.isCliProviderMock.mockImplementation((provider: unknown) => provider === "claude-cli");
  selectFallback("openai", "gpt-5.4");
  state.runEmbeddedAgentMock.mockResolvedValueOnce(createRunResult("fallback"));

  const followupRun = createFollowupRun({
    provider: "anthropic",
    model: "claude-opus-4-7",
    config: {
      agents: {
        defaults: {
          models: { "anthropic/claude-opus-4-7": { agentRuntime: { id: "claude-cli" } } },
        },
      },
    },
  });

  const result = await runTurn({
    followupRun,
    getActiveSessionEntry: () => ({
      sessionId: "session",
      updatedAt: Date.now(),
      agentRuntimeOverride: "claude-cli",
    }),
  });

  expect(result.kind).toBe("success");
  expect(state.runCliAgentMock).not.toHaveBeenCalled();
  expect(state.runEmbeddedAgentMock).toHaveBeenCalledOnce();
  const params = requireRecord(
    requireMockCall(state.runEmbeddedAgentMock, 0, "embedded run params")[0],
    "embedded run params",
  );
  expect(params).not.toHaveProperty("agentHarnessId", "claude-cli");
});

it("keeps plugin-owned CLI turns on the CLI path after observing that runtime", async () => {
  cliBackendsTesting.setDepsForTest({
    resolveRuntimeCliBackends: () => [{ ...cliBackend(), pluginId: "anthropic" }],
  });
  state.isCliProviderMock.mockImplementation((provider: unknown) => provider === "claude-cli");
  selectFallback("anthropic", "claude-sonnet-4-6");
  state.runCliAgentMock.mockResolvedValueOnce(createRunResult("continued"));
  const followupRun = createFollowupRun({
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    modelSelectionLocked: true,
    // Modality preparation looks up the canonical model, not the CLI backend alias.
    thinkingCatalog: [{ provider: "anthropic", id: "claude-sonnet-4-6", input: ["text", "image"] }],
  });

  await runTurn({
    followupRun,
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
