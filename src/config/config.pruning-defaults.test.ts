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
    await withTempHome(async (home) => {
      await writeConfigForTest(home, {
        auth: {
          profiles: {
            "anthropic:me": { provider: "anthropic", mode: "oauth", email: "me@example.com" },
          },
        },
        agents: { defaults: {} },
      });

      const cfg = loadConfig();

      expect(cfg.agents?.defaults?.contextPruning?.mode).toBe("cache-ttl");
      expect(cfg.agents?.defaults?.contextPruning?.ttl).toBe("1h");
      expect(cfg.agents?.defaults?.heartbeat?.every).toBe("1h");
    });
  });

  it("enables cache-ttl pruning + 1h cache TTL for Anthropic API keys", async () => {
    await withTempHome(async (home) => {
      await writeConfigForTest(home, {
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

      const cfg = loadConfig();

      expect(cfg.agents?.defaults?.contextPruning?.mode).toBe("cache-ttl");
      expect(cfg.agents?.defaults?.contextPruning?.ttl).toBe("1h");
      expect(cfg.agents?.defaults?.heartbeat?.every).toBe("30m");
      expect(
        cfg.agents?.defaults?.models?.["anthropic/claude-opus-4-5"]?.params?.cacheRetention,
      ).toBe("short");
    });
  });

  it("adds default cacheRetention for Anthropic Claude models on Bedrock", async () => {
    await withTempHome(async (home) => {
      await writeConfigForTest(home, {
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

      const cfg = loadConfig();

      expect(
        cfg.agents?.defaults?.models?.["amazon-bedrock/us.anthropic.claude-opus-4-6-v1"]?.params
          ?.cacheRetention,
      ).toBe("short");
    });
  });

  it("does not add default cacheRetention for non-Anthropic Bedrock models", async () => {
    await withTempHome(async (home) => {
      await writeConfigForTest(home, {
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

      const cfg = loadConfig();

      expect(
        cfg.agents?.defaults?.models?.["amazon-bedrock/amazon.nova-micro-v1:0"]?.params
          ?.cacheRetention,
      ).toBeUndefined();
    });
  });

  it("does not override explicit contextPruning mode", async () => {
    await withTempHome(async (home) => {
      await writeConfigForTest(home, { agents: { defaults: { contextPruning: { mode: "off" } } } });

      const cfg = loadConfig();

      expect(cfg.agents?.defaults?.contextPruning?.mode).toBe("off");
    });
  });

  it("does not crash when openai-codex-responses provider is configured (regression #49519)", async () => {
    // Regression: normalizeAnthropicModelId used to reference a module-level
    // ANTHROPIC_MODEL_ALIASES const before it was initialized (TDZ), causing a
    // ReferenceError during config load for non-Anthropic providers such as
    // openai-codex-responses. The fix inlines aliases into a switch statement so
    // there is no module-level reference that can be accessed before init.
    await withTempHome(async (home) => {
      await writeConfigForTest(home, {
        auth: {
          profiles: {
            "anthropic:api": { provider: "anthropic", mode: "api_key" },
            "codex:default": { provider: "openai-codex", mode: "api_key" },
          },
        },
        models: {
          providers: {
            "openai-codex": {
              api: "openai-codex-responses",
              models: [{ id: "gpt-5.3-codex" }],
            },
          },
        },
        agents: {
          defaults: {
            model: { primary: "openai-codex/gpt-5.3-codex" },
          },
        },
      });

      // Must not throw — this was the crash site.
      const cfg = loadConfig();

      expect(cfg).toBeDefined();
      // Context pruning defaults should NOT be applied for a non-Anthropic primary model.
      expect(cfg.agents?.defaults?.contextPruning?.mode).toBeUndefined();
    });
  });
});
