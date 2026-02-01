import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createConfigIO } from "./io.js";

async function withTempHome(run: (home: string) => Promise<void>): Promise<void> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-config-invalid-"));
  try {
    await run(home);
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
}

async function writeInvalidConfig(home: string, content: string): Promise<string> {
  const dir = path.join(home, ".openclaw");
  await fs.mkdir(dir, { recursive: true });
  const configPath = path.join(dir, "openclaw.json");
  await fs.writeFile(configPath, content);
  return configPath;
}

describe("config invalid exit behavior", () => {
  const originalProcessExit = process.exit;
  const originalProcessTitle = process.title;
  let mockExit: ReturnType<typeof vi.fn>;
  let mockLogger: { error: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    mockExit = vi.fn();
    process.exit = mockExit as unknown as typeof process.exit;
    mockLogger = {
      error: vi.fn(),
      warn: vi.fn(),
    };
  });

  afterEach(() => {
    process.exit = originalProcessExit;
    process.title = originalProcessTitle;
    vi.restoreAllMocks();
  });

  it("exits with code 1 when OPENCLAW_EXIT_ON_INVALID_CONFIG=1 and config is invalid", async () => {
    await withTempHome(async (home) => {
      // Create config with invalid schema (e.g., wrong type for agents.defaults)
      await writeInvalidConfig(
        home,
        JSON.stringify({
          agents: {
            defaults: {
              model: { invalid: "schema" }, // Invalid - model should be a string or proper object
            },
          },
        }),
      );

      const io = createConfigIO({
        env: { OPENCLAW_EXIT_ON_INVALID_CONFIG: "1" } as NodeJS.ProcessEnv,
        homedir: () => home,
        logger: mockLogger,
      });

      io.loadConfig();

      expect(mockExit).toHaveBeenCalledWith(1);
      expect(mockLogger.error).toHaveBeenCalled();
    });
  });

  it("returns empty config when OPENCLAW_EXIT_ON_INVALID_CONFIG=0 and config is invalid", async () => {
    await withTempHome(async (home) => {
      // Create config with invalid schema
      await writeInvalidConfig(
        home,
        JSON.stringify({
          agents: {
            defaults: {
              model: { invalid: "schema" },
            },
          },
        }),
      );

      const io = createConfigIO({
        env: { OPENCLAW_EXIT_ON_INVALID_CONFIG: "0" } as NodeJS.ProcessEnv,
        homedir: () => home,
        logger: mockLogger,
      });

      const config = io.loadConfig();

      expect(mockExit).not.toHaveBeenCalled();
      expect(config).toEqual({});
    });
  });

  it("exits by default when process.title is 'openclaw' (gateway mode)", async () => {
    await withTempHome(async (home) => {
      process.title = "openclaw";

      await writeInvalidConfig(
        home,
        JSON.stringify({
          agents: {
            defaults: {
              model: { invalid: "schema" },
            },
          },
        }),
      );

      const io = createConfigIO({
        env: {} as NodeJS.ProcessEnv,
        homedir: () => home,
        logger: mockLogger,
      });

      io.loadConfig();

      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });

  it("exits when OPENCLAW_GATEWAY_MODE=1 is set", async () => {
    await withTempHome(async (home) => {
      await writeInvalidConfig(
        home,
        JSON.stringify({
          agents: {
            defaults: {
              model: { invalid: "schema" },
            },
          },
        }),
      );

      const io = createConfigIO({
        env: { OPENCLAW_GATEWAY_MODE: "1" } as NodeJS.ProcessEnv,
        homedir: () => home,
        logger: mockLogger,
      });

      io.loadConfig();

      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });

  it("includes helpful error message for common config mistakes", async () => {
    await withTempHome(async (home) => {
      // Create config with invalid agents.defaults.model
      await writeInvalidConfig(
        home,
        JSON.stringify({
          agents: {
            defaults: {
              model: 12345, // Wrong type - should be string or object
            },
          },
        }),
      );

      const io = createConfigIO({
        env: { OPENCLAW_EXIT_ON_INVALID_CONFIG: "1" } as NodeJS.ProcessEnv,
        homedir: () => home,
        logger: mockLogger,
      });

      io.loadConfig();

      expect(mockExit).toHaveBeenCalledWith(1);
      // Check that error message was logged
      const errorCalls = mockLogger.error.mock.calls.flat().join(" ");
      expect(errorCalls).toContain("Configuration error");
    });
  });

  it("hot-reload path logs warning but does not exit on invalid config", async () => {
    await withTempHome(async (home) => {
      // Create valid config first
      const dir = path.join(home, ".openclaw");
      await fs.mkdir(dir, { recursive: true });
      const configPath = path.join(dir, "openclaw.json");
      await fs.writeFile(configPath, JSON.stringify({ gateway: { mode: "local" } }));

      const io = createConfigIO({
        env: { OPENCLAW_EXIT_ON_INVALID_CONFIG: "1" } as NodeJS.ProcessEnv,
        homedir: () => home,
        logger: mockLogger,
      });

      // Initial load should succeed
      const config = io.loadConfig();
      expect(config.gateway?.mode).toBe("local");
      expect(mockExit).not.toHaveBeenCalled();

      // Now write invalid config
      await fs.writeFile(
        configPath,
        JSON.stringify({
          agents: { defaults: { model: { invalid: true } } },
        }),
      );

      // readConfigFileSnapshot is used by hot-reload and should not exit
      const snapshot = await io.readConfigFileSnapshot();
      expect(snapshot.valid).toBe(false);
      expect(snapshot.issues.length).toBeGreaterThan(0);
      // process.exit should NOT have been called for snapshot reads
      // (only loadConfig calls exit, readConfigFileSnapshot returns invalid snapshot)
    });
  });
});
