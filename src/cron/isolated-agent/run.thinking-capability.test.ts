import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { beforeEach, describe, expect, it } from "vitest";
import { makeIsolatedAgentJobFixture, makeIsolatedAgentParamsFixture } from "./job-fixtures.js";
import { setupRunCronIsolatedAgentTurnSuite } from "./run.suite-helpers.js";
import {
  isThinkingLevelSupportedMock,
  loadModelCatalogMock,
  loadRunCronIsolatedAgentTurn,
  mockRunCronFallbackPassthrough,
  resolveAllowedModelRefMock,
  resolveConfiguredModelRefMock,
  resolveEffectiveAgentRuntimeMock,
  resolveSupportedThinkingLevelMock,
  runEmbeddedAgentMock,
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
