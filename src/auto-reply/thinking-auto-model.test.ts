import { beforeEach, describe, expect, it, vi } from "vitest";
import { runEmbeddedPiAgent } from "../agents/pi-embedded.js";
import { resolveAutoThinkingLevelWithModel } from "./thinking-auto-model.js";

vi.mock("../agents/pi-embedded.js", () => ({
  runEmbeddedPiAgent: vi.fn(),
}));

describe("resolveAutoThinkingLevelWithModel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const baseParams = {
    cfg: {} as never,
    agentDir: "/tmp/agent",
    workspaceDir: "/tmp/workspace",
    provider: "openai-codex",
    model: "gpt-5.3-codex",
    text: "Design a migration plan",
    timeoutMs: 30_000,
    supportsXHigh: true,
  };

  it("returns parsed level when confidence is above threshold", async () => {
    vi.mocked(runEmbeddedPiAgent).mockResolvedValueOnce({
      payloads: [{ text: '{"think":"high","confidence":0.91}' }],
      meta: { durationMs: 1 },
    });

    const level = await resolveAutoThinkingLevelWithModel(baseParams);
    expect(level).toBe("high");
  });

  it("downgrades xhigh to high when unsupported", async () => {
    vi.mocked(runEmbeddedPiAgent).mockResolvedValueOnce({
      payloads: [{ text: '{"think":"xhigh","confidence":0.9}' }],
      meta: { durationMs: 1 },
    });

    const level = await resolveAutoThinkingLevelWithModel({
      ...baseParams,
      supportsXHigh: false,
    });
    expect(level).toBe("high");
  });

  it("returns undefined on low-confidence decisions", async () => {
    vi.mocked(runEmbeddedPiAgent).mockResolvedValueOnce({
      payloads: [{ text: '{"think":"medium","confidence":0.2}' }],
      meta: { durationMs: 1 },
    });

    const level = await resolveAutoThinkingLevelWithModel(baseParams);
    expect(level).toBeUndefined();
  });

  it("returns undefined when classifier output is malformed", async () => {
    vi.mocked(runEmbeddedPiAgent).mockResolvedValueOnce({
      payloads: [{ text: "I think maybe medium" }],
      meta: { durationMs: 1 },
    });

    const level = await resolveAutoThinkingLevelWithModel(baseParams);
    expect(level).toBeUndefined();
  });
});
