import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createReplyPrefixContext } from "./reply-prefix.js";

function makeBundle() {
  const cfg = {
    messages: { responsePrefix: "[{model} ctx:{context} {contextPercent}%]" },
  } as OpenClawConfig;
  return createReplyPrefixContext({ cfg, agentId: "default" });
}

describe("reply-prefix onContextUsage", () => {
  it("populates context and contextPercent from token usage", () => {
    const bundle = makeBundle();
    bundle.onModelSelected({ provider: "anthropic", model: "claude-opus-4-6", thinkLevel: "high" });
    bundle.onContextUsage({ tokens: 15_000, contextWindowTokens: 200_000 });

    const ctx = bundle.responsePrefixContextProvider();
    expect(ctx.context).toBe("15k");
    expect(ctx.contextPercent).toBe("8");
    expect(ctx.model).toBe("claude-opus-4-6");
  });

  it("sets context but omits contextPercent when window is unknown", () => {
    const bundle = makeBundle();
    bundle.onContextUsage({ tokens: 42_000 });
    const ctx = bundle.responsePrefixContextProvider();
    expect(ctx.context).toBe("42k");
    expect(ctx.contextPercent).toBeUndefined();
  });

  it("ignores invalid token counts", () => {
    const bundle = makeBundle();
    bundle.onContextUsage({ tokens: -1, contextWindowTokens: 200_000 });
    const ctx = bundle.responsePrefixContextProvider();
    expect(ctx.context).toBeUndefined();
    expect(ctx.contextPercent).toBeUndefined();
  });

  it("clamps contextPercent to 100 for over-budget usage", () => {
    const bundle = makeBundle();
    bundle.onContextUsage({ tokens: 500_000, contextWindowTokens: 200_000 });
    const ctx = bundle.responsePrefixContextProvider();
    expect(ctx.contextPercent).toBe("100");
  });
});
