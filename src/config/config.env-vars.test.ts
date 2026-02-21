import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadDotEnv } from "../infra/dotenv.js";
import { resolveConfigEnvVars } from "./env-substitution.js";
import { applyConfigEnvVars, collectConfigRuntimeEnvVars } from "./env-vars.js";
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

  it("blocks dangerous startup env vars from config env", async () => {
    await withEnvOverride(
      { BASH_ENV: undefined, SHELL: undefined, OPENROUTER_API_KEY: undefined },
      async () => {
        const config = {
          env: {
            vars: {
              BASH_ENV: "/tmp/pwn.sh",
              SHELL: "/tmp/evil-shell",
              OPENROUTER_API_KEY: "config-key",
            },
          },
        };
        const entries = collectConfigRuntimeEnvVars(config as OpenClawConfig);
        expect(entries.BASH_ENV).toBeUndefined();
        expect(entries.SHELL).toBeUndefined();
        expect(entries.OPENROUTER_API_KEY).toBe("config-key");

        applyConfigEnvVars(config as OpenClawConfig);
        expect(process.env.BASH_ENV).toBeUndefined();
        expect(process.env.SHELL).toBeUndefined();
        expect(process.env.OPENROUTER_API_KEY).toBe("config-key");
      },
    );
  });

  it("drops non-portable env keys from config env", async () => {
    await withEnvOverride({ OPENROUTER_API_KEY: undefined }, async () => {
      const config = {
        env: {
          vars: {
            " BAD KEY": "oops",
            OPENROUTER_API_KEY: "config-key",
          },
          "NOT-PORTABLE": "bad",
        },
      };
      const entries = collectConfigRuntimeEnvVars(config as OpenClawConfig);
      expect(entries.OPENROUTER_API_KEY).toBe("config-key");
      expect(entries[" BAD KEY"]).toBeUndefined();
      expect(entries["NOT-PORTABLE"]).toBeUndefined();
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
}

  describe("lenient mode", () => {
    it("preserves ${VAR} as literal when var is missing and lenient: true", () => {
      const config = {
        sandbox: {
          docker: {
            env: {
              GITHUB_PAT: "${GITHUB_PAT}",
            },
          },
        },
      };
      const envWithoutVar: NodeJS.ProcessEnv = {};
      const result = resolveConfigEnvVars(config, envWithoutVar, { lenient: true }) as typeof config;
      expect(result.sandbox.docker.env.GITHUB_PAT).toBe("${GITHUB_PAT}");
    });

    it("still substitutes vars that are present even in lenient mode", () => {
      const config = {
        sandbox: {
          docker: {
            env: {
              GITHUB_PAT: "${GITHUB_PAT}",
              OPENAI_API_KEY: "${OPENAI_API_KEY}",
            },
          },
        },
      };
      const env: NodeJS.ProcessEnv = { GITHUB_PAT: "ghp_actual_value" };
      const result = resolveConfigEnvVars(config, env, { lenient: true }) as typeof config;
      // Present var is resolved normally
      expect(result.sandbox.docker.env.GITHUB_PAT).toBe("ghp_actual_value");
      // Missing var is preserved as literal
      expect(result.sandbox.docker.env.OPENAI_API_KEY).toBe("${OPENAI_API_KEY}");
    });

    it("throws MissingEnvVarError for missing vars when lenient is not set (default behaviour)", () => {
      const config = {
        sandbox: {
          docker: {
            env: {
              GITHUB_PAT: "${GITHUB_PAT}",
            },
          },
        },
      };
      const envWithoutVar: NodeJS.ProcessEnv = {};
      expect(() => resolveConfigEnvVars(config, envWithoutVar)).toThrow("Missing env var \"GITHUB_PAT\"");
    });

    it("preserves nested ${VAR} refs in arrays and objects when lenient", () => {
      const config = {
        agents: {
          list: [
            {
              sandbox: {
                docker: {
                  env: {
                    SECRET_ONE: "${SECRET_ONE}",
                    SECRET_TWO: "${SECRET_TWO}",
                  },
                },
              },
            },
          ],
        },
      };
      const result = resolveConfigEnvVars(config, {}, { lenient: true }) as typeof config;
      expect(result.agents.list[0].sandbox.docker.env.SECRET_ONE).toBe("${SECRET_ONE}");
      expect(result.agents.list[0].sandbox.docker.env.SECRET_TWO).toBe("${SECRET_TWO}");
    });
  });

});
