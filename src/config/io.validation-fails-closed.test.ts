import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { withTempHome } from "./test-helpers.js";

describe("config validation fail-closed behavior", () => {
  it("throws error in strict mode when validation fails", async () => {
    await withTempHome(async (home) => {
      const configDir = path.join(home, ".openclaw");
      await fs.mkdir(configDir, { recursive: true });

      // Create a config with an invalid plugin entry that will fail validation
      const configPath = path.join(configDir, "openclaw.json");
      await fs.writeFile(
        configPath,
        JSON.stringify({
          agents: { list: [{ id: "pi" }] },
          plugins: {
            enabled: true,
            entries: {
              // This plugin doesn't exist and will cause validation to fail
              "nonexistent-plugin": { enabled: true },
            },
          },
          // Security-critical setting that should NOT be reset to default
          channels: {
            whatsapp: {
              dmPolicy: "allowlist",
              allowFrom: ["+1234567890"],
            },
          },
        }),
        "utf-8",
      );

      process.env.OPENCLAW_CONFIG_PATH = configPath;
      vi.resetModules();

      const { createConfigIO } = await import("./io.js");
      const { default: logger } = await import("../logging/logger.js");

      // Strict mode (used by gateway) should throw
      const strictConfigIO = createConfigIO({
        env: process.env,
        homedir: home,
        logger,
        strict: true,
      });

      // Capture error from single invocation (per Greptile feedback)
      let thrownError: Error | undefined;
      try {
        strictConfigIO.loadConfig();
      } catch (err) {
        thrownError = err as Error;
      }

      expect(thrownError).toBeDefined();
      expect((thrownError as { code?: string }).code).toBe("INVALID_CONFIG");
    });
  });

  it("returns empty config in non-strict mode when validation fails (for CLI repair)", async () => {
    await withTempHome(async (home) => {
      const configDir = path.join(home, ".openclaw");
      await fs.mkdir(configDir, { recursive: true });

      const configPath = path.join(configDir, "openclaw.json");
      await fs.writeFile(
        configPath,
        JSON.stringify({
          agents: { list: [{ id: "pi" }] },
          plugins: {
            enabled: true,
            entries: {
              "nonexistent-plugin": { enabled: true },
            },
          },
        }),
        "utf-8",
      );

      process.env.OPENCLAW_CONFIG_PATH = configPath;
      vi.resetModules();

      const { createConfigIO } = await import("./io.js");
      const { default: logger } = await import("../logging/logger.js");

      // Non-strict mode (used by CLI) should return empty config
      const configIO = createConfigIO({
        env: process.env,
        homedir: home,
        logger,
        strict: false, // default
      });

      // Should return empty config, not throw
      const config = configIO.loadConfig();
      expect(config).toEqual({});
    });
  });

  it("preserves security settings when config is valid", async () => {
    await withTempHome(async (home) => {
      const configDir = path.join(home, ".openclaw");
      await fs.mkdir(configDir, { recursive: true });

      const configPath = path.join(configDir, "openclaw.json");
      await fs.writeFile(
        configPath,
        JSON.stringify({
          agents: { list: [{ id: "pi" }] },
          channels: {
            whatsapp: {
              dmPolicy: "allowlist",
              allowFrom: ["+1234567890"],
            },
          },
        }),
        "utf-8",
      );

      process.env.OPENCLAW_CONFIG_PATH = configPath;
      vi.resetModules();

      const { createConfigIO } = await import("./io.js");
      const { default: logger } = await import("../logging/logger.js");

      const configIO = createConfigIO({
        env: process.env,
        homedir: home,
        logger,
        strict: true,
      });

      // Should load successfully and preserve security settings
      const config = configIO.loadConfig();
      expect(config.channels?.whatsapp?.dmPolicy).toBe("allowlist");
      expect(config.channels?.whatsapp?.allowFrom).toEqual(["+1234567890"]);
    });
  });
});
