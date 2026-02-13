import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveStateDir } from "./paths.js";
import { withEnvOverride, withTempHome } from "./test-helpers.js";

describe("config env vars", () => {
  it("applies env vars from env block when missing", async () => {
    await withTempHome(async (home) => {
      const configDir = path.join(home, ".openclaw");
      await fs.mkdir(configDir, { recursive: true });
      await fs.writeFile(
        path.join(configDir, "openclaw.json"),
        JSON.stringify(
          {
            env: { vars: { OPENROUTER_API_KEY: "config-key" } },
          },
          null,
          2,
        ),
        "utf-8",
      );

      await withEnvOverride({ OPENROUTER_API_KEY: undefined }, async () => {
        const { loadConfig } = await import("./config.js");
        loadConfig();
        expect(process.env.OPENROUTER_API_KEY).toBe("config-key");
      });
    });
  });

  it("does not override existing env vars", async () => {
    await withTempHome(async (home) => {
      const configDir = path.join(home, ".openclaw");
      await fs.mkdir(configDir, { recursive: true });
      await fs.writeFile(
        path.join(configDir, "openclaw.json"),
        JSON.stringify(
          {
            env: { vars: { OPENROUTER_API_KEY: "config-key" } },
          },
          null,
          2,
        ),
        "utf-8",
      );

      await withEnvOverride({ OPENROUTER_API_KEY: "existing-key" }, async () => {
        const { loadConfig } = await import("./config.js");
        loadConfig();
        expect(process.env.OPENROUTER_API_KEY).toBe("existing-key");
      });
    });
  });

  it("applies env vars from env.vars when missing", async () => {
    await withTempHome(async (home) => {
      const configDir = path.join(home, ".openclaw");
      await fs.mkdir(configDir, { recursive: true });
      await fs.writeFile(
        path.join(configDir, "openclaw.json"),
        JSON.stringify(
          {
            env: { vars: { GROQ_API_KEY: "gsk-config" } },
          },
          null,
          2,
        ),
        "utf-8",
      );

      await withEnvOverride({ GROQ_API_KEY: undefined }, async () => {
        const { loadConfig } = await import("./config.js");
        loadConfig();
        expect(process.env.GROQ_API_KEY).toBe("gsk-config");
      });
    });
  });

  it("loads ${VAR} substitutions from ~/.openclaw/.env on repeated runtime loads", async () => {
    await withTempHome(async (home) => {
      await withEnvOverride(
        {
          OPENCLAW_STATE_DIR: path.join(home, ".openclaw"),
          CLAWDBOT_STATE_DIR: undefined,
          OPENCLAW_HOME: undefined,
          CLAWDBOT_HOME: undefined,
          BRAVE_API_KEY: undefined,
          OPENCLAW_DISABLE_CONFIG_CACHE: "1",
        },
        async () => {
          const configDir = resolveStateDir(process.env, () => home);
          await fs.mkdir(configDir, { recursive: true });
          await fs.writeFile(
            path.join(configDir, "openclaw.json"),
            JSON.stringify(
              {
                tools: {
                  web: {
                    search: {
                      apiKey: "${BRAVE_API_KEY}",
                    },
                  },
                },
              },
              null,
              2,
            ),
            "utf-8",
          );
          await fs.writeFile(path.join(configDir, ".env"), "BRAVE_API_KEY=from-dotenv\n", "utf-8");

          const { loadConfig } = await import("./config.js");

          const first = loadConfig();
          expect(first.tools?.web?.search?.apiKey).toBe("from-dotenv");

          delete process.env.BRAVE_API_KEY;
          const second = loadConfig();
          expect(second.tools?.web?.search?.apiKey).toBe("from-dotenv");
        },
      );
    });
  });
});
