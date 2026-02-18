import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadDotEnv } from "../infra/dotenv.js";
import { resolveConfigEnvVars } from "./env-substitution.js";
import { applyConfigEnvVars } from "./env-vars.js";
import { withEnvOverride, withTempHome } from "./test-helpers.js";
import type { OpenClawConfig } from "./types.js";

describe("config env vars", () => {
  it("applies env vars from env block when missing", async () => {
    await withEnvOverride({ OPENROUTER_API_KEY: undefined }, async () => {
      applyConfigEnvVars({ env: { vars: { OPENROUTER_API_KEY: "config-key" } } } as OpenClawConfig);
      expect(process.env.OPENROUTER_API_KEY).toBe("config-key");
    });
  });

  it("does not override existing env vars", async () => {
    await withEnvOverride({ OPENROUTER_API_KEY: "existing-key" }, async () => {
      applyConfigEnvVars({ env: { vars: { OPENROUTER_API_KEY: "config-key" } } } as OpenClawConfig);
      expect(process.env.OPENROUTER_API_KEY).toBe("existing-key");
    });
  });

  it("applies env vars from env.vars when missing", async () => {
    await withEnvOverride({ GROQ_API_KEY: undefined }, async () => {
      applyConfigEnvVars({ env: { vars: { GROQ_API_KEY: "gsk-config" } } } as OpenClawConfig);
      expect(process.env.GROQ_API_KEY).toBe("gsk-config");
    });
  });

  it("loads ${VAR} substitutions from ~/.openclaw/.env on repeated runtime loads", async () => {
    await withTempHome(async (_home) => {
      await withEnvOverride({ BRAVE_API_KEY: undefined }, async () => {
        const stateDir = process.env.OPENCLAW_STATE_DIR?.trim();
        if (!stateDir) {
          throw new Error("Expected OPENCLAW_STATE_DIR to be set by withTempHome");
        }
        await fs.mkdir(stateDir, { recursive: true });
        await fs.writeFile(path.join(stateDir, ".env"), "BRAVE_API_KEY=from-dotenv\n", "utf-8");

        const config: OpenClawConfig = {
          tools: {
            web: {
              search: {
                apiKey: "${BRAVE_API_KEY}",
              },
            },
          },
        };

        loadDotEnv({ quiet: true });
        const first = resolveConfigEnvVars(config, process.env) as OpenClawConfig;
        expect(first.tools?.web?.search?.apiKey).toBe("from-dotenv");

        delete process.env.BRAVE_API_KEY;
        loadDotEnv({ quiet: true });
        const second = resolveConfigEnvVars(config, process.env) as OpenClawConfig;
        expect(second.tools?.web?.search?.apiKey).toBe("from-dotenv");
      });
    });
  });
});
