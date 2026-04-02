import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";

const runEmbeddedPiAgentMock = vi.fn();

vi.mock("../agents/agent-scope.js", () => ({
  resolveDefaultAgentId: () => "main",
  resolveAgentWorkspaceDir: () => "/tmp/openclaw-workspace",
  resolveAgentDir: () => "/tmp/openclaw-workspace/agents/main/agent",
  resolveAgentEffectiveModelPrimary: () => "openai/gpt-5.4",
}));

vi.mock("../agents/model-selection.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../agents/model-selection.js")>();
  return {
    ...actual,
    parseModelRef: vi.fn(() => ({ provider: "openai", model: "gpt-5.4" })),
  };
});

vi.mock("../agents/pi-embedded.js", () => ({
  runEmbeddedPiAgent: (params: unknown) => runEmbeddedPiAgentMock(params),
}));

const { generateSlugViaLLM } = await import("./llm-slug-generator.js");

describe("generateSlugViaLLM", () => {
  beforeEach(() => {
    runEmbeddedPiAgentMock.mockReset();
    runEmbeddedPiAgentMock.mockResolvedValue({
      payloads: [{ text: "great-slug" }],
      meta: { durationMs: 5, agentMeta: { sessionId: "s", provider: "openai", model: "gpt-5.4" } },
    });
  });

  it("passes gateway subagent binding through embedded runs", async () => {
    const slug = await generateSlugViaLLM({
      sessionContent: "A conversation about better plugin runtime dispatch",
      cfg: {} as OpenClawConfig,
    });

    expect(slug).toBe("great-slug");
    expect(runEmbeddedPiAgentMock).toHaveBeenCalledWith(
      expect.objectContaining({
        allowGatewaySubagentBinding: true,
      }),
    );
  });
});
