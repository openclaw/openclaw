import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { createReplyPrefixContext } from "./reply-prefix.js";

describe("createReplyPrefixContext", () => {
  it("pre-seeds model, provider, and thinkingLevel from config defaults", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          model: { primary: "openrouter/moonshotai/kimi-k2.5" },
        },
      },
      messages: {
        responsePrefix: "{model} - {thinkingLevel} 🦞: ",
      },
    };

    const { prefixContext } = createReplyPrefixContext({ cfg, agentId: "main" });

    expect(prefixContext.provider).toBe("openrouter");
    expect(prefixContext.model).toBe("kimi-k2.5");
    expect(prefixContext.modelFull).toBe("openrouter/moonshotai/kimi-k2.5");
    expect(prefixContext.thinkingLevel).toBeDefined();
    expect(prefixContext.thinkingLevel).not.toBe("");
  });

  it("onModelSelected overwrites pre-seeded defaults", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          model: { primary: "openrouter/moonshotai/kimi-k2.5" },
        },
      },
    };

    const { prefixContext, onModelSelected } = createReplyPrefixContext({ cfg, agentId: "main" });

    // Pre-seeded values
    expect(prefixContext.provider).toBe("openrouter");
    expect(prefixContext.model).toBe("kimi-k2.5");

    // Simulate model selection at runtime
    onModelSelected({ provider: "anthropic", model: "claude-opus-4-6", thinkLevel: "high" });

    expect(prefixContext.provider).toBe("anthropic");
    expect(prefixContext.model).toBe("claude-opus-4-6");
    expect(prefixContext.modelFull).toBe("anthropic/claude-opus-4-6");
    expect(prefixContext.thinkingLevel).toBe("high");
  });

  it("uses hardcoded defaults when no model configured", () => {
    const cfg: OpenClawConfig = {};

    const { prefixContext } = createReplyPrefixContext({ cfg, agentId: "main" });

    // Should have some default model/provider (from DEFAULT_PROVIDER/DEFAULT_MODEL)
    expect(prefixContext.provider).toBeTruthy();
    expect(prefixContext.model).toBeTruthy();
    expect(prefixContext.thinkingLevel).toBeDefined();
  });
});
