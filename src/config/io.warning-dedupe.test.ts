import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createConfigIO } from "./io.js";

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-config-"));
  try {
    await run(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

describe("config io warning logging", () => {
  it("dedupes warning logs when config is unchanged", async () => {
    await withTempDir(async (dir) => {
      const configPath = path.join(dir, "openclaw.json");
      await fs.writeFile(
        configPath,
        JSON.stringify({ plugins: { entries: { "missing-plugin": {} } } }, null, 2),
        "utf-8",
      );

      const logger = { warn: vi.fn(), error: vi.fn() };
      const io = createConfigIO({
        configPath,
        env: {} as NodeJS.ProcessEnv,
        homedir: () => dir,
        logger,
      });

      io.loadConfig();
      io.loadConfig();

      expect(logger.warn).toHaveBeenCalledTimes(1);
      expect(String(logger.warn.mock.calls[0]?.[0] ?? "")).toContain("Config warnings:");
    });
  });

  it("logs warning again when config changes", async () => {
    await withTempDir(async (dir) => {
      const configPath = path.join(dir, "openclaw.json");
      const logger = { warn: vi.fn(), error: vi.fn() };
      const io = createConfigIO({
        configPath,
        env: {} as NodeJS.ProcessEnv,
        homedir: () => dir,
        logger,
      });

      await fs.writeFile(
        configPath,
        JSON.stringify({ plugins: { entries: { "missing-plugin": {} } } }, null, 2),
        "utf-8",
      );
      io.loadConfig();

      await fs.writeFile(
        configPath,
        JSON.stringify({ plugins: { entries: { "missing-plugin-2": {} } } }, null, 2),
        "utf-8",
      );
      io.loadConfig();

      expect(logger.warn).toHaveBeenCalledTimes(2);
    });
  });
});
