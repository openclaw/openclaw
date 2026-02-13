import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";

const { runEmbeddedPiAgent } = vi.hoisted(() => ({
  runEmbeddedPiAgent: vi.fn(),
}));

vi.mock("../agents/pi-embedded.js", () => ({
  runEmbeddedPiAgent,
}));

vi.mock("../agents/agent-scope.js", () => ({
  resolveDefaultAgentId: vi.fn().mockReturnValue("main"),
  resolveAgentWorkspaceDir: vi.fn().mockReturnValue("/tmp/workspace"),
  resolveAgentDir: vi.fn().mockReturnValue("/tmp/agent"),
}));

import { generateSlugViaLLM } from "./llm-slug-generator.js";

describe("generateSlugViaLLM", () => {
  beforeEach(() => {
    runEmbeddedPiAgent.mockReset();
  });

  it("uses configured default provider/model for the slug generation run", async () => {
    runEmbeddedPiAgent.mockResolvedValue({
      payloads: [{ text: "Roadmap Plan" }],
    });

    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          model: {
            primary: "minimax/MiniMax-M2.5",
          },
        },
      },
    };

    const slug = await generateSlugViaLLM({
      sessionContent: "User asked for a roadmap plan",
      cfg,
    });

    expect(slug).toBe("roadmap-plan");
    expect(runEmbeddedPiAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "minimax",
        model: "MiniMax-M2.5",
      }),
    );
  });

  it("falls back to built-in defaults when no model is configured", async () => {
    runEmbeddedPiAgent.mockResolvedValue({
      payloads: [{ text: "bug-fix" }],
    });

    const slug = await generateSlugViaLLM({
      sessionContent: "Fix the bug",
      cfg: {},
    });

    expect(slug).toBe("bug-fix");
    expect(runEmbeddedPiAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "anthropic",
        model: "claude-opus-4-6",
      }),
    );
  });
});
