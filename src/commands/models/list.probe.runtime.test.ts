import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";

const runEmbeddedPiAgentMock = vi.fn();
const loadModelCatalogMock = vi.fn();

vi.mock("../../agents/model-catalog.js", () => ({
  loadModelCatalog: (params: unknown) => loadModelCatalogMock(params),
}));

vi.mock("../../agents/pi-embedded.js", () => ({
  runEmbeddedPiAgent: (params: unknown) => runEmbeddedPiAgentMock(params),
}));

vi.mock("../../agents/auth-profiles.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../agents/auth-profiles.js")>();
  return {
    ...actual,
    ensureAuthProfileStore: () => ({ version: 1, profiles: {}, order: {} }),
    listProfilesForProvider: () => [],
  };
});

const { runAuthProbes } = await import("./list.probe.js");

describe("runAuthProbes runtime flags", () => {
  beforeEach(() => {
    loadModelCatalogMock.mockReset();
    loadModelCatalogMock.mockResolvedValue([
      { id: "gpt-5.4", name: "GPT-5.4", provider: "openai" },
    ]);
    runEmbeddedPiAgentMock.mockReset();
    runEmbeddedPiAgentMock.mockResolvedValue({
      payloads: [{ text: "OK" }],
      meta: { durationMs: 5, agentMeta: { sessionId: "s", provider: "openai", model: "gpt-5.4" } },
    });
    process.env.OPENAI_API_KEY = "test-openai-key";
  });

  afterEach(() => {
    delete process.env.OPENAI_API_KEY;
  });

  it("passes gateway subagent binding through auth probe runs", async () => {
    const summary = await runAuthProbes({
      cfg: {} as OpenClawConfig,
      providers: ["openai"],
      modelCandidates: ["openai/gpt-5.4"],
      options: {
        timeoutMs: 5_000,
        concurrency: 1,
        maxTokens: 8,
      },
    });

    expect(summary.totalTargets).toBe(1);
    expect(runEmbeddedPiAgentMock).toHaveBeenCalledWith(
      expect.objectContaining({
        allowGatewaySubagentBinding: true,
      }),
    );
  });
});
