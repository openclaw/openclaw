import { describe, expect, it } from "vitest";
import { validateConfigObject } from "./validation.js";

describe("config: memorySearch legacy alias", () => {
  it("maps top-level memorySearch into agents.defaults", () => {
    const res = validateConfigObject({
      memorySearch: {
        provider: "local",
        local: { modelPath: "hf:example/embedding-model" },
        query: { maxResults: 7 },
      },
      agents: {
        defaults: { workspace: "/workspace/root" },
      },
    });

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.config.agents?.defaults?.memorySearch?.provider).toBe("local");
      expect(res.config.agents?.defaults?.memorySearch?.local?.modelPath).toBe(
        "hf:example/embedding-model",
      );
      expect(res.config.agents?.defaults?.memorySearch?.query?.maxResults).toBe(7);
    }
  });

  it("does not override explicit agents.defaults.memorySearch", () => {
    const res = validateConfigObject({
      memorySearch: { provider: "openai" },
      agents: {
        defaults: { memorySearch: { provider: "local" } },
      },
    });

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.config.agents?.defaults?.memorySearch?.provider).toBe("local");
    }
  });
});
