import { expect, it, vi } from "vitest";
import { testing as cliBackendsTesting } from "../../agents/cli-backends.test-support.js";
import { setupExecutionSuite } from "./agent-runner-execution-suite.test-support.js";
import {
  createRunResult,
  createFollowupRun,
  runFallbackCandidate,
  expectMockCallArgFields,
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

it("forwards turn context and tool policy for the concrete Codex runtime", async () => {
  const provider = "openai",
    model = "gpt-5.6-luna",
    agentRuntime = "codex";
  await useProductionEmbeddedRunExecutionParamsForTest();
  loadProviderScopedThinkingCatalog.mockResolvedValue([]);
  selectFallback(provider, model);
  state.runEmbeddedAgentMock.mockResolvedValueOnce(createRunResult("final"));
  const turnContext = { start: 0, text: "Current conversation." };
  const followupRun = createFollowupRun({
    extraSystemPrompt: "Current conversation.\n\nPersistent policy.",
    extraSystemPromptTurnContext: turnContext,
    provider,
    model,
    skipProviderRuntimeHints: true,
    thinkingCatalog: [{ provider, id: model, input: ["text"] }],
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
    forceRestartSafeTools: true,
    forceCodeModeTools: true,
    toolsAllow: ["message"],
    extraSystemPrompt: "Current conversation.\n\nPersistent policy.",
    extraSystemPromptTurnContext: turnContext,
  });
});

it.each([
  { queued: "group", current: undefined, expected: "group" },
  { queued: "direct", current: "Channel", expected: "channel" },
] as const)(
  "forwards authoritative $expected type over queued $queued metadata",
  async ({ queued, current, expected }) => {
    const sessionKey = "agent:main:opaque:binding";
    state.isCliProviderMock.mockReturnValue(true);
    selectFallback("codex-cli", "gpt-5.4");
    state.runCliAgentMock.mockResolvedValueOnce(createRunResult("final"));
    await runTurn({
      sessionKey,
      followupRun: createFollowupRun({
        agentId: "main",
        provider: "codex-cli",
        model: "gpt-5.4",
        sessionKey,
        chatType: queued,
      }),
      sessionCtx: { Provider: "discord", MessageSid: "msg", ChatType: current },
    });
    expectMockCallArgFields(state.runCliAgentMock, 0, "CLI run params", {
      sessionKey,
      chatType: expected,
    });
  },
);

it.each(["standard", "daybreak_blue", "daybreak_red"] as const)(
  "allows only Standard Access for a chat CLI turn (%s)",
  async (cyberAccessProgram) => {
    state.isCliProviderMock.mockReturnValue(true);
    selectFallback("codex-cli", "gpt-5.4");
    state.runCliAgentMock.mockResolvedValueOnce(createRunResult("final"));
    const result = await runTurn({
      followupRun: createFollowupRun({
        provider: "codex-cli",
        model: "gpt-5.4",
        cyberAccessProgram,
      }),
    });
    if (cyberAccessProgram === "standard") {
      expect(result.kind).toBe("success");
      expect(state.runCliAgentMock).toHaveBeenCalledOnce();
    } else {
      expect(result.kind).toBe("final");
      expect(state.runCliAgentMock).not.toHaveBeenCalled();
    }
  },
);

it.each([false, true])("routes a CLI runtime with observed ownership %s", async (observed) => {
  const model = observed ? "claude-sonnet-4-6" : "gpt-5.4";
  cliBackendsTesting.setDepsForTest({
    resolveRuntimeCliBackends: () => (observed ? [{ ...cliBackend(), pluginId: "anthropic" }] : []),
    ...(!observed &&
      ({
        resolvePluginSetupCliBackend: ({ backend, config }) =>
          backend === "claude-cli" && config
            ? { pluginId: "anthropic", backend: { ...cliBackend(), bundleMcp: false } }
            : undefined,
      } satisfies Parameters<typeof cliBackendsTesting.setDepsForTest>[0])),
  });
  state.isCliProviderMock.mockImplementation((provider: unknown) => provider === "claude-cli");
  selectFallback(observed ? "anthropic" : "openai", model);
  const selected = observed ? state.runCliAgentMock : state.runEmbeddedAgentMock;
  const unused = observed ? state.runEmbeddedAgentMock : state.runCliAgentMock;
  selected.mockResolvedValueOnce(createRunResult("final"));
  const followupRun = createFollowupRun({
    provider: "anthropic",
    model: observed ? model : "claude-opus-4-7",
    ...(observed
      ? {
          modelSelectionLocked: true,
          // Modality preparation uses the canonical model, not the CLI backend alias.
          thinkingCatalog: [{ provider: "anthropic", id: model, input: ["text", "image"] }],
        }
      : {
          config: {
            agents: {
              defaults: {
                models: { "anthropic/claude-opus-4-7": { agentRuntime: { id: "claude-cli" } } },
              },
            },
          },
        }),
  });

  const result = await runTurn({
    followupRun,
    getActiveSessionEntry: () => ({
      sessionId: "session",
      updatedAt: 1,
      agentRuntimeOverride: "claude-cli",
      ...(observed && {
        modelSelectionLocked: true,
        pluginOwnerId: "cli-owner",
        agentHarnessId: "claude-cli",
      }),
    }),
  });

  expect(result.kind).toBe("success");
  expect(unused).not.toHaveBeenCalled();
  expect(selected).toHaveBeenCalledOnce();
  if (observed) {
    expectMockCallArgFields(selected, 0, "CLI run params", {
      provider: "claude-cli",
      model,
      modelHasVision: true,
    });
  } else {
    expect(selected.mock.calls[0]?.[0]).not.toHaveProperty("agentHarnessId", "claude-cli");
  }
});
