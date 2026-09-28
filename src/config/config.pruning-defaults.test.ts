import { describe, expect, it } from "vitest";
import { applyProviderConfigDefaultsForConfig } from "./provider-policy.js";

describe("config pruning defaults", () => {
  it("enables cache-ttl pruning + 1h cache TTL for Anthropic API keys", () => {
    const cfg = applyProviderConfigDefaultsForConfig({
      provider: "anthropic",
      env: {},
      config: {
        auth: {
          profiles: {
            "anthropic:api": { provider: "anthropic", mode: "api_key" },
          },
        },
        agents: {
          defaults: {
            model: { primary: "anthropic/claude-opus-4-6" },
          },
        },
      },
    });

    expect(cfg.agents?.defaults?.contextPruning?.mode).toBe("cache-ttl");
    expect(cfg.agents?.defaults?.contextPruning?.ttl).toBe("1h");
    expect(cfg.agents?.defaults?.heartbeat?.every).toBe("30m");
    expect(
      cfg.agents?.defaults?.models?.["anthropic/claude-opus-4-6"]?.params?.cacheRetention,
    ).toBe("short");
  });
});
