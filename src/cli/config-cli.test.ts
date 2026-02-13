import { Command } from "commander";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Test for issue #6070:
 * `openclaw config set` should use snapshot.parsed (raw user config) instead of
 * snapshot.config (runtime-merged config with defaults), to avoid overwriting
 * the entire config with defaults when validation fails or config is unreadable.
 */

const mockLog = vi.fn();
const mockError = vi.fn();
const mockExit = vi.fn((code: number) => {
  const errorMessages = mockError.mock.calls.map((c) => c.join(" ")).join("; ");
  throw new Error(`__exit__:${code} - ${errorMessages}`);
});

vi.mock("../runtime.js", () => ({
  defaultRuntime: {
    log: (...args: unknown[]) => mockLog(...args),
    error: (...args: unknown[]) => mockError(...args),
    exit: (code: number) => mockExit(code),
  },
}));

async function withTempHome(run: (home: string) => Promise<void>): Promise<void> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-config-cli-"));
  const originalEnv = { ...process.env };
  try {
    // Override config path to use temp directory
    process.env.OPENCLAW_CONFIG_PATH = path.join(home, ".openclaw", "openclaw.json");
    await fs.mkdir(path.join(home, ".openclaw"), { recursive: true });
    await run(home);
  } finally {
    process.env = originalEnv;
    await fs.rm(home, { recursive: true, force: true });
  }
}

async function readConfigFile(home: string): Promise<Record<string, unknown>> {
  const configPath = path.join(home, ".openclaw", "openclaw.json");
  const content = await fs.readFile(configPath, "utf-8");
  return JSON.parse(content);
}

async function writeConfigFile(home: string, config: Record<string, unknown>): Promise<void> {
  const configPath = path.join(home, ".openclaw", "openclaw.json");
  await fs.writeFile(configPath, JSON.stringify(config, null, 2));
}

describe("config cli", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("config set - issue #6070", () => {
    it("preserves existing config keys when setting a new value", async () => {
      await withTempHome(async (home) => {
        // Set up a config file with multiple existing settings (using valid schema)
        const initialConfig = {
          agents: {
            list: [{ id: "main" }, { id: "oracle", workspace: "~/oracle-workspace" }],
          },
          gateway: {
            port: 18789,
          },
          tools: {
            allow: ["group:fs"],
          },
          logging: {
            level: "debug",
          },
        };
        await writeConfigFile(home, initialConfig);

        // Run config set to add a new value
        const { registerConfigCli } = await import("./config-cli.js");
        const program = new Command();
        program.exitOverride();
        registerConfigCli(program);

        await program.parseAsync(["config", "set", "gateway.auth.mode", "token"], { from: "user" });

        // Read the config file and verify ALL original keys are preserved
        const finalConfig = await readConfigFile(home);

        // The new value should be set
        expect((finalConfig.gateway as Record<string, unknown>).auth).toEqual({ mode: "token" });

        // ALL original settings must still be present (this is the key assertion for #6070)
        // The key bug in #6070 was that runtime defaults (like agents.defaults) were being
        // written to the file, and paths were being expanded. This test verifies the fix.
        expect(finalConfig.agents).not.toHaveProperty("defaults"); // No runtime defaults injected
        expect((finalConfig.agents as Record<string, unknown>).list).toEqual(
          initialConfig.agents.list,
        );
        expect((finalConfig.gateway as Record<string, unknown>).port).toBe(18789);
        expect(finalConfig.tools).toEqual(initialConfig.tools);
        expect(finalConfig.logging).toEqual(initialConfig.logging);
      });
    });

    it("does not inject runtime defaults into the written config", async () => {
      await withTempHome(async (home) => {
        // Set up a minimal config file
        const initialConfig = {
          gateway: { port: 18789 },
        };
        await writeConfigFile(home, initialConfig);

        // Run config set
        const { registerConfigCli } = await import("./config-cli.js");
        const program = new Command();
        program.exitOverride();
        registerConfigCli(program);

        await program.parseAsync(["config", "set", "gateway.auth.mode", "token"], {
          from: "user",
        });

        // Read the config file
        const finalConfig = await readConfigFile(home);

        // The config should NOT contain runtime defaults that weren't originally in the file
        // These are examples of defaults that get merged in by applyModelDefaults, applyAgentDefaults, etc.
        expect(finalConfig).not.toHaveProperty("agents.defaults.model");
        expect(finalConfig).not.toHaveProperty("agents.defaults.contextWindow");
        expect(finalConfig).not.toHaveProperty("agents.defaults.maxTokens");
        expect(finalConfig).not.toHaveProperty("messages.ackReaction");
        expect(finalConfig).not.toHaveProperty("sessions.persistence");

        // Original config should still be present
        expect((finalConfig.gateway as Record<string, unknown>).port).toBe(18789);
        // New value should be set
        expect((finalConfig.gateway as Record<string, unknown>).auth).toEqual({ mode: "token" });
      });
    });
  });

  describe("config unset - issue #6070", () => {
    it("preserves existing config keys when unsetting a value", async () => {
      await withTempHome(async (home) => {
        // Set up a config file with multiple existing settings (using valid schema)
        const initialConfig = {
          agents: { list: [{ id: "main" }] },
          gateway: { port: 18789 },
          tools: {
            profile: "coding",
            alsoAllow: ["agents_list"],
          },
          logging: {
            level: "debug",
          },
        };
        await writeConfigFile(home, initialConfig);

        // Run config unset to remove a value
        const { registerConfigCli } = await import("./config-cli.js");
        const program = new Command();
        program.exitOverride();
        registerConfigCli(program);

        await program.parseAsync(["config", "unset", "tools.alsoAllow"], { from: "user" });

        // Read the config file and verify ALL original keys (except the unset one) are preserved
        const finalConfig = await readConfigFile(home);

        // The value should be removed
        expect(finalConfig.tools as Record<string, unknown>).not.toHaveProperty("alsoAllow");

        // ALL other original settings must still be present (no runtime defaults injected)
        expect(finalConfig.agents).not.toHaveProperty("defaults");
        expect((finalConfig.agents as Record<string, unknown>).list).toEqual(
          initialConfig.agents.list,
        );
        expect(finalConfig.gateway).toEqual(initialConfig.gateway);
        expect((finalConfig.tools as Record<string, unknown>).profile).toBe("coding");
        expect(finalConfig.logging).toEqual(initialConfig.logging);
      });
    });
  });
});
