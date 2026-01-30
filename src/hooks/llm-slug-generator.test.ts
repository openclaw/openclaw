import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { OpenClawConfig } from "../config/config.js";
import { runEmbeddedPiAgent } from "../agents/pi-embedded.js";
import { withTempHome } from "../../test/helpers/temp-home.js";

import { generateSlugViaLLM } from "./llm-slug-generator.js";

vi.mock("../agents/pi-embedded.js", () => ({
  runEmbeddedPiAgent: vi.fn(),
}));

describe("llm-slug-generator", () => {
  it("uses the configured default model (not anthropic defaults)", async () => {
    await withTempHome(async (home) => {
      vi.mocked(runEmbeddedPiAgent).mockResolvedValue({
        payloads: [{ text: "api-design" }],
        meta: {
          durationMs: 1,
          agentMeta: { sessionId: "s", provider: "openai", model: "gpt-4.1-mini" },
        },
      });

      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            workspace: path.join(home, "workspace"),
            model: { primary: "openai/gpt-4.1-mini" },
          },
        },
      };

      const slug = await generateSlugViaLLM({
        sessionContent: "user: hello\nassistant: hi",
        cfg,
      });

      expect(slug).toBe("api-design");

      expect(runEmbeddedPiAgent).toHaveBeenCalledOnce();
      const call = vi.mocked(runEmbeddedPiAgent).mock.calls[0]?.[0];
      expect(call?.provider).toBe("openai");
      expect(call?.model).toBe("gpt-4.1-mini");
    });
  });
});
