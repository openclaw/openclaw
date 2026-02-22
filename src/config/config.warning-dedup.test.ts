import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createConfigIO } from "./io.js";

async function withTempHome(run: (home: string) => Promise<void>): Promise<void> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-config-warning-"));
  try {
    await run(home);
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
}

describe("config warning deduplication", () => {
  it("logs config warnings only once for repeated loadConfig calls", async () => {
    await withTempHome(async (home) => {
      const dir = path.join(home, ".openclaw");
      await fs.mkdir(dir, { recursive: true });
      const configPath = path.join(dir, "openclaw.json");
      // Config with a disabled built-in plugin that still has config present.
      // This triggers a "plugin disabled ... but config is present" warning.
      // Use an empty config object to avoid schema validation failures.
      await fs.writeFile(
        configPath,
        JSON.stringify(
          {
            plugins: {
              entries: {
                discord: { enabled: false, config: {} },
              },
            },
          },
          null,
          2,
        ),
      );

      const warned: string[] = [];
      const logger = {
        info: vi.fn(),
        warn: vi.fn((...args: unknown[]) => {
          warned.push(String(args[0]));
        }),
        error: vi.fn(),
        debug: vi.fn(),
      };

      const io = createConfigIO({
        env: {} as NodeJS.ProcessEnv,
        homedir: () => home,
        logger,
      });

      // Call loadConfig multiple times (simulating repeated config reads)
      io.loadConfig();
      io.loadConfig();
      io.loadConfig();

      // The "Config warnings:" message should appear at most once
      const configWarnings = warned.filter((msg) => msg.includes("Config warnings:"));
      expect(configWarnings).toHaveLength(1);
    });
  });

  it("re-logs warnings when the warning content changes", async () => {
    await withTempHome(async (home) => {
      const dir = path.join(home, ".openclaw");
      await fs.mkdir(dir, { recursive: true });
      const configPath = path.join(dir, "openclaw.json");

      const warned: string[] = [];
      const logger = {
        info: vi.fn(),
        warn: vi.fn((...args: unknown[]) => {
          warned.push(String(args[0]));
        }),
        error: vi.fn(),
        debug: vi.fn(),
      };

      // First config: only discord disabled with config
      await fs.writeFile(
        configPath,
        JSON.stringify({
          plugins: { entries: { discord: { enabled: false, config: {} } } },
        }),
      );

      const io = createConfigIO({
        env: {} as NodeJS.ProcessEnv,
        homedir: () => home,
        logger,
      });

      io.loadConfig();

      // Change config: discord AND slack disabled with config (different warning text)
      await fs.writeFile(
        configPath,
        JSON.stringify({
          plugins: {
            entries: {
              discord: { enabled: false, config: {} },
              slack: { enabled: false, config: {} },
            },
          },
        }),
      );

      io.loadConfig();

      // Both distinct warnings should have been logged
      const configWarnings = warned.filter((msg) => msg.includes("Config warnings:"));
      expect(configWarnings).toHaveLength(2);
      expect(configWarnings[0]).toContain("discord");
      expect(configWarnings[1]).toContain("slack");
    });
  });

  it("re-logs a warning that disappears and reappears", async () => {
    await withTempHome(async (home) => {
      const dir = path.join(home, ".openclaw");
      await fs.mkdir(dir, { recursive: true });
      const configPath = path.join(dir, "openclaw.json");

      const warned: string[] = [];
      const logger = {
        info: vi.fn(),
        warn: vi.fn((...args: unknown[]) => {
          warned.push(String(args[0]));
        }),
        error: vi.fn(),
        debug: vi.fn(),
      };

      // Config with warning
      await fs.writeFile(
        configPath,
        JSON.stringify({
          plugins: { entries: { discord: { enabled: false, config: {} } } },
        }),
      );

      const io = createConfigIO({
        env: {} as NodeJS.ProcessEnv,
        homedir: () => home,
        logger,
      });

      io.loadConfig(); // logs warning

      // Config without warning (user fixes it)
      await fs.writeFile(configPath, JSON.stringify({}));
      io.loadConfig(); // no warning

      // Same warning reappears (user re-breaks config)
      await fs.writeFile(
        configPath,
        JSON.stringify({
          plugins: { entries: { discord: { enabled: false, config: {} } } },
        }),
      );
      io.loadConfig(); // should log warning again

      const configWarnings = warned.filter((msg) => msg.includes("Config warnings:"));
      expect(configWarnings).toHaveLength(2);
    });
  });
});
