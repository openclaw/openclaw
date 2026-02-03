import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withEnvOverride, withTempHome } from "./test-helpers.js";

/**
 * VULN-159: Block dangerous environment variables from config
 *
 * Tests that dangerous environment variables that could enable code injection
 * (NODE_OPTIONS, LD_PRELOAD, DYLD_INSERT_LIBRARIES, etc.) are blocked from
 * being set via config.env.vars.
 */
describe("config dangerous env var blocking", () => {
  it("blocks NODE_OPTIONS from config", async () => {
    await withTempHome(async (home) => {
      const configDir = path.join(home, ".openclaw");
      await fs.mkdir(configDir, { recursive: true });
      await fs.writeFile(
        path.join(configDir, "openclaw.json"),
        JSON.stringify(
          {
            env: {
              vars: {
                NODE_OPTIONS: "--require=/tmp/malicious.js",
                SAFE_VAR: "safe-value",
              },
            },
          },
          null,
          2,
        ),
        "utf-8",
      );

      await withEnvOverride({ NODE_OPTIONS: undefined, SAFE_VAR: undefined }, async () => {
        const { loadConfig } = await import("./config.js");
        loadConfig();
        // NODE_OPTIONS should be blocked
        expect(process.env.NODE_OPTIONS).toBeUndefined();
        // Safe vars should still work
        expect(process.env.SAFE_VAR).toBe("safe-value");
      });
    });
  });

  it("blocks LD_PRELOAD from config", async () => {
    await withTempHome(async (home) => {
      const configDir = path.join(home, ".openclaw");
      await fs.mkdir(configDir, { recursive: true });
      await fs.writeFile(
        path.join(configDir, "openclaw.json"),
        JSON.stringify(
          {
            env: { vars: { LD_PRELOAD: "/tmp/malicious.so" } },
          },
          null,
          2,
        ),
        "utf-8",
      );

      await withEnvOverride({ LD_PRELOAD: undefined }, async () => {
        const { loadConfig } = await import("./config.js");
        loadConfig();
        expect(process.env.LD_PRELOAD).toBeUndefined();
      });
    });
  });

  it("blocks DYLD_INSERT_LIBRARIES from config", async () => {
    await withTempHome(async (home) => {
      const configDir = path.join(home, ".openclaw");
      await fs.mkdir(configDir, { recursive: true });
      await fs.writeFile(
        path.join(configDir, "openclaw.json"),
        JSON.stringify(
          {
            env: { vars: { DYLD_INSERT_LIBRARIES: "/tmp/evil.dylib" } },
          },
          null,
          2,
        ),
        "utf-8",
      );

      await withEnvOverride({ DYLD_INSERT_LIBRARIES: undefined }, async () => {
        const { loadConfig } = await import("./config.js");
        loadConfig();
        expect(process.env.DYLD_INSERT_LIBRARIES).toBeUndefined();
      });
    });
  });

  it("blocks PYTHONPATH from config", async () => {
    await withTempHome(async (home) => {
      const configDir = path.join(home, ".openclaw");
      await fs.mkdir(configDir, { recursive: true });
      await fs.writeFile(
        path.join(configDir, "openclaw.json"),
        JSON.stringify(
          {
            env: { vars: { PYTHONPATH: "/tmp/malicious-python" } },
          },
          null,
          2,
        ),
        "utf-8",
      );

      await withEnvOverride({ PYTHONPATH: undefined }, async () => {
        const { loadConfig } = await import("./config.js");
        loadConfig();
        expect(process.env.PYTHONPATH).toBeUndefined();
      });
    });
  });

  it("blocks BASH_ENV from config", async () => {
    await withTempHome(async (home) => {
      const configDir = path.join(home, ".openclaw");
      await fs.mkdir(configDir, { recursive: true });
      await fs.writeFile(
        path.join(configDir, "openclaw.json"),
        JSON.stringify(
          {
            env: { vars: { BASH_ENV: "/tmp/evil.sh" } },
          },
          null,
          2,
        ),
        "utf-8",
      );

      await withEnvOverride({ BASH_ENV: undefined }, async () => {
        const { loadConfig } = await import("./config.js");
        loadConfig();
        expect(process.env.BASH_ENV).toBeUndefined();
      });
    });
  });

  it("blocks pattern-based dangerous vars like LD_LIBRARY_PATH", async () => {
    await withTempHome(async (home) => {
      const configDir = path.join(home, ".openclaw");
      await fs.mkdir(configDir, { recursive: true });
      await fs.writeFile(
        path.join(configDir, "openclaw.json"),
        JSON.stringify(
          {
            env: {
              vars: {
                LD_LIBRARY_PATH: "/tmp/lib",
                DYLD_FRAMEWORK_PATH: "/tmp/frameworks",
              },
            },
          },
          null,
          2,
        ),
        "utf-8",
      );

      await withEnvOverride(
        { LD_LIBRARY_PATH: undefined, DYLD_FRAMEWORK_PATH: undefined },
        async () => {
          const { loadConfig } = await import("./config.js");
          loadConfig();
          expect(process.env.LD_LIBRARY_PATH).toBeUndefined();
          expect(process.env.DYLD_FRAMEWORK_PATH).toBeUndefined();
        },
      );
    });
  });

  it("allows safe API key variables", async () => {
    await withTempHome(async (home) => {
      const configDir = path.join(home, ".openclaw");
      await fs.mkdir(configDir, { recursive: true });
      await fs.writeFile(
        path.join(configDir, "openclaw.json"),
        JSON.stringify(
          {
            env: {
              vars: {
                OPENAI_API_KEY: "sk-test",
                ANTHROPIC_API_KEY: "sk-ant-test",
                MY_CUSTOM_VAR: "custom-value",
              },
            },
          },
          null,
          2,
        ),
        "utf-8",
      );

      await withEnvOverride(
        { OPENAI_API_KEY: undefined, ANTHROPIC_API_KEY: undefined, MY_CUSTOM_VAR: undefined },
        async () => {
          const { loadConfig } = await import("./config.js");
          loadConfig();
          expect(process.env.OPENAI_API_KEY).toBe("sk-test");
          expect(process.env.ANTHROPIC_API_KEY).toBe("sk-ant-test");
          expect(process.env.MY_CUSTOM_VAR).toBe("custom-value");
        },
      );
    });
  });
});
