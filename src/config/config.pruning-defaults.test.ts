import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withEnvAsync } from "../test-utils/env.js";
import { loadConfig } from "./config.js";
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
  });

  it("adds cacheRetention defaults for dated Anthropic primary model refs", async () => {
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
  });

  it("adds default cacheRetention for Anthropic Claude models on Bedrock", async () => {
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
  });

  it("adds default cacheRetention for OpenRouter Anthropic Claude models", async () => {
    await withTempHome(async (home) => {
      await writeConfigForTest(home, {
        auth: {
          profiles: {
            "anthropic:api": { provider: "anthropic", mode: "api_key" },
          },
        },
        agents: {
          defaults: {
            model: { primary: "openrouter/anthropic/claude-sonnet-4-6" },
          },
        },
      });

      const cfg = loadConfig();

      expect(
        cfg.agents?.defaults?.models?.["openrouter/anthropic/claude-sonnet-4-6"]?.params
          ?.cacheRetention,
      ).toBe("short");
    });
  });

  it("adds default cacheRetention for any provider with anthropic/ model id", async () => {
    await withTempHome(async (home) => {
      await writeConfigForTest(home, {
        auth: {
          profiles: {
            "anthropic:api": { provider: "anthropic", mode: "api_key" },
          },
        },
        agents: {
          defaults: {
            model: { primary: "kilocode/anthropic/claude-opus-4-6" },
          },
        },
      });

      const cfg = loadConfig();

      expect(
        cfg.agents?.defaults?.models?.["kilocode/anthropic/claude-opus-4-6"]?.params
          ?.cacheRetention,
      ).toBe("short");
    });
  });

  it("preserves explicit cacheRetention long for OpenRouter Claude", async () => {
    await withTempHome(async (home) => {
      await writeConfigForTest(home, {
        auth: {
          profiles: {
            "anthropic:api": { provider: "anthropic", mode: "api_key" },
          },
        },
        agents: {
          defaults: {
            models: {
              "openrouter/anthropic/claude-sonnet-4-6": {
                params: { cacheRetention: "long" },
              },
            },
          },
        },
      });

      const cfg = loadConfig();

      expect(
        cfg.agents?.defaults?.models?.["openrouter/anthropic/claude-sonnet-4-6"]?.params
          ?.cacheRetention,
      ).toBe("long");
    });
  });

  it("does not override explicit contextPruning mode", async () => {
    const cfg = await loadConfigForHome({
      agents: { defaults: { contextPruning: { mode: "off" } } },
    });

    expect(cfg.agents?.defaults?.contextPruning?.mode).toBe("off");
  });
});
