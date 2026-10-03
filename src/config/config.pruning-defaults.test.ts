import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "./config.js";
import { applyProviderConfigDefaultsForConfig } from "./provider-policy.js";

function applyAnthropicDefaultsForTest(config: OpenClawConfig) {
  return applyProviderConfigDefaultsForConfig({ provider: "anthropic", config, env: {} });
}

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
    expect(cfg.agents?.defaults?.heartbeat).toBeUndefined();
    expect(
      cfg.agents?.defaults?.models?.["anthropic/claude-opus-4-6"]?.params?.cacheRetention,
    ).toBe("short");
  });
  it("does not enable contextPruning by default", () => {
    const cfg = applyAnthropicDefaultsForTest({ agents: { defaults: {} } });

    expect(cfg.agents?.defaults?.contextPruning?.mode).toBeUndefined();
  });

  it("does not override explicit contextPruning mode", () => {
    const cfg = applyAnthropicDefaultsForTest({
      auth: {
        profiles: {
          "anthropic:api": { provider: "anthropic", mode: "api_key" },
        },
      },
      agents: { defaults: { contextPruning: { mode: "off" } } },
    });

    expect(cfg.agents?.defaults?.contextPruning?.mode).toBe("off");
  });
});
