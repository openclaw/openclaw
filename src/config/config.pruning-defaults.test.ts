import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { withEnvAsync } from "../test-utils/env.js";
import { loadConfig, resetConfigRuntimeState } from "./config.js";
import { withTempHome } from "./test-helpers.js";

async function writeConfigForTest(home: string, config: unknown): Promise<void> {
  const configDir = path.join(home, ".openclaw");
  await fs.mkdir(configDir, { recursive: true });
  await fs.writeFile(
    path.join(configDir, "openclaw.json"),
    JSON.stringify(config, null, 2),
    "utf-8",
  );
}

async function loadConfigForHome(config: unknown) {
  return await withTempHome(async (home) => {
    await writeConfigForTest(home, config);
    return loadConfig();
  });
}

function expectAnthropicPruningDefaults(
  cfg: ReturnType<typeof loadConfig>,
  heartbeatEvery = "30m",
) {
  expect(cfg.agents?.defaults?.contextPruning?.mode).toBe("cache-ttl");
  expect(cfg.agents?.defaults?.contextPruning?.ttl).toBe("1h");
  expect(cfg.agents?.defaults?.heartbeat?.every).toBe(heartbeatEvery);
}

describe("config pruning defaults", () => {
  beforeEach(() => {
    resetConfigRuntimeState();
  });

  afterEach(() => {
    resetConfigRuntimeState();
  });

  it("does not enable contextPruning by default", async () => {
    await withEnvAsync({ ANTHROPIC_API_KEY: "", ANTHROPIC_OAUTH_TOKEN: "" }, async () => {
      await withTempHome(async (home) => {
        await writeConfigForTest(home, { agents: { defaults: {} } });

        const cfg = loadConfig();

        expect(cfg.agents?.defaults?.contextPruning?.mode).toBeUndefined();
      });
    });
  });

  it("enables cache-ttl pruning + 1h heartbeat for Anthropic OAuth", async () => {
    const cfg = await loadConfigForHome({
      auth: {
        profiles: {
          "anthropic:me": { provider: "anthropic", mode: "oauth", email: "me@example.com" },
        },
      },
      agents: { defaults: {} },
    });

    expectAnthropicPruningDefaults(cfg, "1h");
  });

  it("enables cache-ttl pruning + 1h cache TTL for Anthropic API keys", async () => {
    const cfg = await loadConfigForHome({
      auth: {
        profiles: {
          "anthropic:api": { provider: "anthropic", mode: "api_key" },
        },
      },
      agents: {
        defaults: {
          model: { primary: "anthropic/claude-opus-4-5" },
        },
      },
    });

    expectAnthropicPruningDefaults(cfg);
    expect(
      cfg.agents?.defaults?.models?.["anthropic/claude-opus-4-5"]?.params?.cacheRetention,
    ).toBe("short");
    expect(
      cfg.agents?.defaults?.models?.["anthropic/claude-opus-4-5"]?.params?.sessionCacheTtl,
    ).toBe("1h");
    expect(
      cfg.agents?.defaults?.models?.["anthropic/claude-opus-4-5"]?.params?.timeBasedContextCompact,
    ).toBeUndefined();
  });

  it("adds cacheRetention and sessionCacheTtl defaults for dated Anthropic primary model refs", async () => {
    const cfg = await loadConfigForHome({
      auth: {
        profiles: {
          "anthropic:api": { provider: "anthropic", mode: "api_key" },
        },
      },
      agents: {
        defaults: {
          model: { primary: "anthropic/claude-sonnet-4-20250514" },
        },
      },
    });

    expectAnthropicPruningDefaults(cfg);
    expect(
      cfg.agents?.defaults?.models?.["anthropic/claude-sonnet-4-20250514"]?.params?.cacheRetention,
    ).toBe("short");
    expect(
      cfg.agents?.defaults?.models?.["anthropic/claude-sonnet-4-20250514"]?.params?.sessionCacheTtl,
    ).toBe("1h");
    expect(
      cfg.agents?.defaults?.models?.["anthropic/claude-sonnet-4-20250514"]?.params
        ?.timeBasedContextCompact,
    ).toBeUndefined();
  });

  it("adds default cacheRetention and sessionCacheTtl for Anthropic Claude models on Bedrock", async () => {
    const cfg = await loadConfigForHome({
      auth: {
        profiles: {
          "anthropic:api": { provider: "anthropic", mode: "api_key" },
        },
      },
      agents: {
        defaults: {
          model: { primary: "amazon-bedrock/us.anthropic.claude-opus-4-6-v1" },
        },
      },
    });

    expect(
      cfg.agents?.defaults?.models?.["amazon-bedrock/us.anthropic.claude-opus-4-6-v1"]?.params
        ?.cacheRetention,
    ).toBe("short");
    expect(
      cfg.agents?.defaults?.models?.["amazon-bedrock/us.anthropic.claude-opus-4-6-v1"]?.params
        ?.sessionCacheTtl,
    ).toBe("1h");
    expect(
      cfg.agents?.defaults?.models?.["amazon-bedrock/us.anthropic.claude-opus-4-6-v1"]?.params
        ?.timeBasedContextCompact,
    ).toBeUndefined();
  });

  it("does not add default cacheRetention for non-Anthropic Bedrock models", async () => {
    const cfg = await loadConfigForHome({
      auth: {
        profiles: {
          "anthropic:api": { provider: "anthropic", mode: "api_key" },
        },
      },
      agents: {
        defaults: {
          model: { primary: "amazon-bedrock/amazon.nova-micro-v1:0" },
        },
      },
    });

    expect(
      cfg.agents?.defaults?.models?.["amazon-bedrock/amazon.nova-micro-v1:0"]?.params
        ?.cacheRetention,
    ).toBeUndefined();
    expect(
      cfg.agents?.defaults?.models?.["amazon-bedrock/amazon.nova-micro-v1:0"]?.params
        ?.sessionCacheTtl,
    ).toBeUndefined();
  });

  it("adds sessionCacheTtl even when cacheRetention is explicitly configured", async () => {
    const cfg = await loadConfigForHome({
      auth: {
        profiles: {
          "anthropic:api": { provider: "anthropic", mode: "api_key" },
        },
      },
      agents: {
        defaults: {
          model: { primary: "anthropic/claude-opus-4-5" },
          models: {
            "anthropic/claude-opus-4-5": {
              params: { cacheRetention: "long" },
            },
          },
        },
      },
    });

    expect(
      cfg.agents?.defaults?.models?.["anthropic/claude-opus-4-5"]?.params?.cacheRetention,
    ).toBe("long");
    expect(
      cfg.agents?.defaults?.models?.["anthropic/claude-opus-4-5"]?.params?.sessionCacheTtl,
    ).toBe("1h");
    expect(
      cfg.agents?.defaults?.models?.["anthropic/claude-opus-4-5"]?.params?.timeBasedContextCompact,
    ).toBeUndefined();
  });

  it("does not override explicit contextPruning mode", async () => {
    const cfg = await loadConfigForHome({
      agents: { defaults: { contextPruning: { mode: "off" } } },
    });

    expect(cfg.agents?.defaults?.contextPruning?.mode).toBe("off");
  });
});
