import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createConfigIO } from "./io.js";

async function withTempHome(run: (home: string) => Promise<void>): Promise<void> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-bak-fallback-"));
  try {
    await run(home);
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
}

describe("config .bak fallback on invalid primary config", () => {
  it("falls back to .bak when primary config is invalid", async () => {
    await withTempHome(async (home) => {
      const configDir = path.join(home, ".openclaw");
      await fs.mkdir(configDir, { recursive: true });
      const configPath = path.join(configDir, "openclaw.json");

      // Write an invalid primary config (bad key that fails validation)
      await fs.writeFile(configPath, JSON.stringify({ gateway: { port: "not-a-number" } }));

      // Write a valid .bak with a known port
      await fs.writeFile(`${configPath}.bak`, JSON.stringify({ gateway: { port: 19876 } }));

      const io = createConfigIO({ env: {} as NodeJS.ProcessEnv, homedir: () => home });
      const cfg = io.loadConfig();
      expect(cfg.gateway?.port).toBe(19876);
    });
  });

  it("throws when both primary and .bak are invalid", async () => {
    await withTempHome(async (home) => {
      const configDir = path.join(home, ".openclaw");
      await fs.mkdir(configDir, { recursive: true });
      const configPath = path.join(configDir, "openclaw.json");

      // Both configs are invalid
      await fs.writeFile(configPath, JSON.stringify({ gateway: { port: "bad" } }));
      await fs.writeFile(`${configPath}.bak`, JSON.stringify({ gateway: { port: "also-bad" } }));

      const io = createConfigIO({ env: {} as NodeJS.ProcessEnv, homedir: () => home });
      expect(() => io.loadConfig()).toThrow("Invalid config");
    });
  });

  it("throws when primary is invalid and no .bak exists", async () => {
    await withTempHome(async (home) => {
      const configDir = path.join(home, ".openclaw");
      await fs.mkdir(configDir, { recursive: true });
      const configPath = path.join(configDir, "openclaw.json");

      await fs.writeFile(configPath, JSON.stringify({ gateway: { port: "bad" } }));
      // No .bak file

      const io = createConfigIO({ env: {} as NodeJS.ProcessEnv, homedir: () => home });
      expect(() => io.loadConfig()).toThrow("Invalid config");
    });
  });

  it("loads primary config normally when it is valid (no fallback needed)", async () => {
    await withTempHome(async (home) => {
      const configDir = path.join(home, ".openclaw");
      await fs.mkdir(configDir, { recursive: true });
      const configPath = path.join(configDir, "openclaw.json");

      await fs.writeFile(configPath, JSON.stringify({ gateway: { port: 12345 } }));

      const io = createConfigIO({ env: {} as NodeJS.ProcessEnv, homedir: () => home });
      const cfg = io.loadConfig();
      expect(cfg.gateway?.port).toBe(12345);
    });
  });
});
