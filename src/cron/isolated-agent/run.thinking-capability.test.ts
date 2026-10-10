import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { beforeEach, describe, expect, it } from "vitest";
import {
  runFallbackModelAttempt,
  runInitialModelFallbackAttempt,
  type TestModelFallbackRunnerParams,
} from "../../agents/test-helpers/model-fallback-runner.test-support.js";
import { makeIsolatedAgentJobFixture, makeIsolatedAgentParamsFixture } from "./job-fixtures.js";
import { setupRunCronIsolatedAgentTurnSuite } from "./run.suite-helpers.js";
import {
  isThinkingLevelSupportedMock,
  loadModelCatalogMock,
  loadModelCatalogOwnerMock,
  loadRunCronIsolatedAgentTurn,
  mockRunCronFallbackPassthrough,
  resolveAllowedModelRefMock,
  resolveConfiguredModelRefMock,
  resolveEffectiveAgentRuntimeMock,
  resolveSupportedThinkingLevelMock,
  resolveThinkingDefaultMock,
  runEmbeddedAgentMock,
  runWithModelFallbackMock,
} from "./run.test-harness.js";

const runCronIsolatedAgentTurn = await loadRunCronIsolatedAgentTurn();
const requireRecord = createRequireRecord("record", "expected-non-array-record");
const CODEX_EFFORTS = ["low", "medium", "high", "xhigh", "max"];

function runCodexCronTurn(thinking: string) {
  return runCronIsolatedAgentTurn(
    makeIsolatedAgentParamsFixture({
      sessionKey: "cron:thinking-capability",
      cfg: {
        agents: {
          defaults: { models: { "openai/gpt-5.6-luna": { agentRuntime: { id: "codex" } } } },
        },
      },
      job: makeIsolatedAgentJobFixture({
        id: "thinking-capability-job",
        payload: {
          kind: "agentTurn",
          message: "summarize",
          model: "openai/gpt-5.6-luna",
          thinking,
        },
      }),
    }),
  );
}

describe("runCronIsolatedAgentTurn model thinking capability", () => {
  setupRunCronIsolatedAgentTurnSuite();

  beforeEach(() => {
    resolveConfiguredModelRefMock.mockReturnValue({ provider: "openai", model: "gpt-5.6-luna" });
    resolveAllowedModelRefMock.mockReturnValue({
      ref: { provider: "openai", model: "gpt-5.6-luna" },
    });
    resolveEffectiveAgentRuntimeMock.mockReturnValue("codex");
    isThinkingLevelSupportedMock.mockReturnValue(true);
    resolveSupportedThinkingLevelMock.mockImplementation(({ level }: { level?: string }) => level);
    mockRunCronFallbackPassthrough();
  });

  it("passes the hydrated Codex effort list so max is not dropped", async () => {
    loadModelCatalogMock.mockResolvedValue([
      {
        provider: "openai",
        id: "gpt-5.6-luna",
        name: "GPT-5.6 Luna",
        reasoning: true,
        compat: { supportedReasoningEfforts: CODEX_EFFORTS },
      },
    ]);

    await runCodexCronTurn("max");

    const embeddedCall = requireRecord(runEmbeddedAgentMock.mock.calls[0]?.[0]);
    expect(embeddedCall.thinkLevel).toBe("max");
    expect(embeddedCall.modelThinkingCapability).toEqual({
      provider: "openai",
      modelId: "gpt-5.6-luna",
      agentRuntime: "codex",
      compat: { supportedReasoningEfforts: CODEX_EFFORTS },
    });
  });

  it("passes no capability when the catalog has no row for the candidate", async () => {
    loadModelCatalogMock.mockResolvedValue([]);

    await runCodexCronTurn("high");

    const embeddedCall = requireRecord(runEmbeddedAgentMock.mock.calls[0]?.[0]);
    expect(embeddedCall.thinkLevel).toBe("high");
    expect(embeddedCall.modelThinkingCapability).toBeUndefined();
  });
});

describe("runCronIsolatedAgentTurn runtime model thinking", () => {
  setupRunCronIsolatedAgentTurnSuite();

  beforeEach(() => {
    resolveConfiguredModelRefMock.mockReturnValue({
      provider: "anthropic",
      model: "claude-opus-4-6",
    });
    mockRunCronFallbackPassthrough();
  });

  it("skips live catalog hydration when model thinking is off", async () => {
    resolveAllowedModelRefMock.mockReturnValue({
      ref: { provider: "ollama", model: "minimax-m3:cloud" },
    });
    loadModelCatalogMock.mockResolvedValue([]);

    await runCronIsolatedAgentTurn(
      makeIsolatedAgentParamsFixture({
        cfg: {
          agents: {
            defaults: { models: { "ollama/minimax-m3:cloud": { params: { thinking: "off" } } } },
          },
        },
        job: makeIsolatedAgentJobFixture({
          payload: {
            kind: "agentTurn",
            message: "summarize",
            model: "ollama/minimax-m3:cloud",
          },
        }),
      }),
    );

    expect(loadModelCatalogMock).toHaveBeenCalledTimes(1);
    expect(resolveThinkingDefaultMock).not.toHaveBeenCalled();
    const embeddedCall = requireRecord(runEmbeddedAgentMock.mock.calls[0]?.[0]);
    expect(embeddedCall.provider).toBe("ollama");
    expect(embeddedCall.model).toBe("minimax-m3:cloud");
    expect(embeddedCall.thinkLevel).toBe("off");
  });

  it("hydrates runtime metadata for a reasoning-capable fallback candidate", async () => {
    resolveAllowedModelRefMock.mockImplementation(({ raw }: { raw: string }) => {
      const [provider, model] = raw.split("/");
      return { ref: { provider, model } };
    });
    // Keep the admitted owner snapshot separate from per-candidate live hydration.
    loadModelCatalogOwnerMock.mockImplementation(async (params) => ({
      agentId: params.agentId ?? "default",
      agentDir: params.agentDir ?? "/tmp/agent-dir",
      workspaceDir: params.workspaceDir,
      config: params.config,
      modelCatalog: {
        entries: [{ provider: "openai", id: "gpt-5.6-sol", reasoning: true }],
        routeVariants: [],
      },
    }));
    loadModelCatalogMock
      .mockResolvedValueOnce([{ provider: "openai", id: "gpt-5.6-sol", reasoning: true }])
      .mockResolvedValueOnce([
        { provider: "openai", id: "gpt-5.6-sol", reasoning: true },
        { provider: "OLLAMA", id: "minimax-m3:cloud", reasoning: true },
      ]);
    resolveThinkingDefaultMock.mockImplementation(
      ({
        catalog,
        model,
      }: {
        catalog?: Array<{ id?: string; reasoning?: boolean }>;
        model?: string;
      }) =>
        model === "minimax-m3:cloud" &&
        catalog?.some((entry) => entry.id === "minimax-m3:cloud" && entry.reasoning === true)
          ? "medium"
          : "off",
    );
    runWithModelFallbackMock.mockImplementation(async (params: TestModelFallbackRunnerParams) => {
      await runInitialModelFallbackAttempt(params);
      const result = await runFallbackModelAttempt(params, "ollama", "minimax-m3:cloud", "unknown");
      return {
        result,
        provider: "ollama",
        model: "minimax-m3:cloud",
        attempts: [],
      };
    });

    await runCronIsolatedAgentTurn(
      makeIsolatedAgentParamsFixture({
        cfg: {
          agents: {
            defaults: {
              models: {
                "openai/gpt-5.6-sol": {},
                "ollama/*": {},
              },
            },
          },
        },
        job: makeIsolatedAgentJobFixture({
          payload: {
            kind: "agentTurn",
            message: "summarize",
            model: "openai/gpt-5.6-sol",
          },
        }),
      }),
    );

    expect(loadModelCatalogMock).toHaveBeenCalledTimes(2);
    expect(loadModelCatalogMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        provider: "openai",
        model: "gpt-5.6-sol",
        agentRuntime: "openclaw",
      }),
    );
    expect(loadModelCatalogMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        provider: "ollama",
        model: "minimax-m3:cloud",
        agentRuntime: "openclaw",
      }),
    );
    expect(runEmbeddedAgentMock.mock.calls.map((call) => call[0].thinkLevel)).toEqual([
      "off",
      "medium",
    ]);
  });
});
