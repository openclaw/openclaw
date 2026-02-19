import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { createReplyPrefixContext } from "./reply-prefix.js";

describe("createReplyPrefixContext", () => {
  it("seeds template context with the configured default model before model selection", () => {
    const ctx = createReplyPrefixContext({
      cfg: {
        agents: {
          defaults: {
            model: { primary: "openai-codex/gpt-5.3-codex" },
            thinkingDefault: "low",
          },
        },
        messages: { responsePrefix: "[{model}]" },
      } as OpenClawConfig,
      agentId: "main",
    });

    expect(ctx.prefixContext.provider).toBe("openai-codex");
    expect(ctx.prefixContext.model).toBe("gpt-5.3-codex");
    expect(ctx.prefixContext.modelFull).toBe("openai-codex/gpt-5.3-codex");
    expect(ctx.prefixContext.thinkingLevel).toBe("low");
  });

  it("still updates template context when a runtime model is selected", () => {
    const ctx = createReplyPrefixContext({
      cfg: {
        agents: {
          defaults: {
            model: { primary: "openai-codex/gpt-5.3-codex" },
          },
        },
        messages: { responsePrefix: "[{model}]" },
      } as OpenClawConfig,
      agentId: "main",
    });

    ctx.onModelSelected({
      provider: "anthropic",
      model: "claude-opus-4-6-20260205",
      thinkLevel: "high",
    });

    expect(ctx.prefixContext.provider).toBe("anthropic");
    expect(ctx.prefixContext.model).toBe("claude-opus-4-6");
    expect(ctx.prefixContext.modelFull).toBe("anthropic/claude-opus-4-6-20260205");
    expect(ctx.prefixContext.thinkingLevel).toBe("high");
  });
});
