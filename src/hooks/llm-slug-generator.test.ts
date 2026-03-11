import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_PROVIDER } from "../agents/defaults.js";
import type { OpenClawConfig } from "../config/config.js";

vi.mock("../agents/pi-embedded.js", () => ({
  runEmbeddedPiAgent: vi.fn().mockResolvedValue({
    payloads: [{ text: "test-slug" }],
  }),
}));

vi.mock("../agents/agent-scope.js", () => ({
  resolveDefaultAgentId: vi.fn().mockReturnValue("test-agent"),
  resolveAgentWorkspaceDir: vi.fn().mockReturnValue("/tmp/workspace"),
  resolveAgentDir: vi.fn().mockReturnValue("/tmp/agent"),
  resolveAgentEffectiveModelPrimary: vi.fn().mockReturnValue("analysis-model"),
}));

import { runEmbeddedPiAgent } from "../agents/pi-embedded.js";
import { generateSlugViaLLM } from "./llm-slug-generator.js";

describe("llm-slug-generator", () => {
  describe("model alias resolution", () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    it("should resolve model alias to actual provider/model", async () => {
      const mockConfig = {
        agents: {
          defaults: {
            model: {
              primary: "analysis-model",
            },
            models: {
              "openai-codex/gpt-5.2": {
                alias: "analysis-model",
              },
            },
          },
        },
      } as unknown as OpenClawConfig;

      await generateSlugViaLLM({
        sessionContent: "Test conversation content",
        cfg: mockConfig,
      });

      expect(runEmbeddedPiAgent).toHaveBeenCalledTimes(1);

      const callArgs = vi.mocked(runEmbeddedPiAgent).mock.calls[0][0];
      expect(callArgs.provider).toBe("openai-codex");
      expect(callArgs.model).toBe("gpt-5.2");
    });

    it("should fallback to default provider when alias not found", async () => {
      const { resolveAgentEffectiveModelPrimary } = await import("../agents/agent-scope.js");
      vi.mocked(resolveAgentEffectiveModelPrimary).mockReturnValueOnce("unknown-alias");

      const mockConfig = {
        agents: {
          defaults: {
            model: {
              primary: "unknown-alias",
            },
            models: {},
          },
        },
      } as unknown as OpenClawConfig;

      await generateSlugViaLLM({
        sessionContent: "Test conversation content",
        cfg: mockConfig,
      });

      expect(runEmbeddedPiAgent).toHaveBeenCalledTimes(1);

      const callArgs = vi.mocked(runEmbeddedPiAgent).mock.calls[0][0];
      expect(callArgs.provider).toBe(DEFAULT_PROVIDER);
      expect(callArgs.model).toBe("unknown-alias");
    });

    it("should handle full provider/model reference without alias", async () => {
      const { resolveAgentEffectiveModelPrimary } = await import("../agents/agent-scope.js");
      vi.mocked(resolveAgentEffectiveModelPrimary).mockReturnValueOnce(
        "custom-provider/custom-model",
      );

      const mockConfig = {
        agents: {
          defaults: {
            model: {
              primary: "custom-provider/custom-model",
            },
            models: {},
          },
        },
      } as unknown as OpenClawConfig;

      await generateSlugViaLLM({
        sessionContent: "Test conversation content",
        cfg: mockConfig,
      });

      expect(runEmbeddedPiAgent).toHaveBeenCalledTimes(1);

      const callArgs = vi.mocked(runEmbeddedPiAgent).mock.calls[0][0];
      expect(callArgs.provider).toBe("custom-provider");
      expect(callArgs.model).toBe("custom-model");
    });
  });
});
