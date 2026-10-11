import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  runFallbackModelAttempt,
  runInitialModelFallbackAttempt,
  type TestModelFallbackRunnerParams,
} from "../../agents/test-helpers/model-fallback-runner.test-support.js";
import {
  makeIsolatedAgentJobFixture as makeJob,
  makeIsolatedAgentParamsFixture as makeParams,
} from "./job-fixtures.js";
import { setupRunCronIsolatedAgentTurnSuite } from "./run.suite-helpers.js";
import {
  loadModelCatalogMock,
  loadModelCatalogOwnerMock,
  loadRunCronIsolatedAgentTurn,
  mockRunCronFallbackPassthrough,
  resolveAllowedModelRefMock,
  resolveConfiguredModelRefMock,
  resolveThinkingDefaultMock,
  runEmbeddedAgentMock,
  runWithModelFallbackMock,
} from "./run.test-harness.js";

const runCronIsolatedAgentTurn = await loadRunCronIsolatedAgentTurn();
const requireRecord = createRequireRecord("record", "expected-non-array-record");

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
      makeParams({
        sessionKey: "cron:model-fwd",
        cfg: {
          agents: {
            defaults: { models: { "ollama/minimax-m3:cloud": { params: { thinking: "off" } } } },
          },
        },
        job: makeJob({
          id: "model-fwd-job",
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
    const initialCatalog = [
      { provider: "openai", id: "gpt-5.6-sol", name: "Initial model", reasoning: true },
    ];
    const fallbackCatalog = [
      ...initialCatalog,
      { provider: "OLLAMA", id: "minimax-m3:cloud", name: "Fallback model", reasoning: true },
    ];
    loadModelCatalogMock.mockResolvedValue(initialCatalog);
    const runtime = await import("./run-model-selection.runtime.js");
    // Reuse the admitted host row; only the missing fallback needs scoped hydration.
    const scopedCatalog = vi
      .spyOn(runtime, "loadProviderScopedThinkingCatalog")
      .mockImplementation(async ({ provider }) =>
        provider === "ollama" ? fallbackCatalog : initialCatalog,
      );
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

    try {
      await runCronIsolatedAgentTurn(
        makeParams({
          sessionKey: "cron:model-fwd",
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
          job: makeJob({
            id: "model-fwd-job",
            payload: {
              kind: "agentTurn",
              message: "summarize",
              model: "openai/gpt-5.6-sol",
            },
          }),
        }),
      );

      expect(loadModelCatalogOwnerMock).toHaveBeenCalledOnce();
      expect(loadModelCatalogMock).toHaveBeenCalledOnce();
      expect(
        scopedCatalog.mock.calls.map(([scope]) => [
          scope.provider,
          scope.model,
          scope.agentRuntime,
        ]),
      ).toEqual([["ollama", "minimax-m3:cloud", "openclaw"]]);
      expect(runEmbeddedAgentMock.mock.calls.map((call) => call[0].thinkLevel)).toEqual([
        "off",
        "medium",
      ]);
    } finally {
      scopedCatalog.mockRestore();
    }
  });
});
