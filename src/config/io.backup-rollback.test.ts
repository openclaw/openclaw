import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withTempHome } from "./home-env.test-harness.js";
import { tryLoadValidConfigBackup } from "./io.js";

describe("tryLoadValidConfigBackup", () => {
  async function setupConfigDir(home: string) {
    const configDir = path.join(home, ".openclaw");
    await fs.mkdir(configDir, { recursive: true });
    return path.join(configDir, "openclaw.json");
  }

  it("returns null when no backup files exist", async () => {
    await withTempHome("backup-rollback-", async (home) => {
      const configPath = await setupConfigDir(home);
      await fs.writeFile(configPath, '{"invalid": }', "utf-8");

      const result = await tryLoadValidConfigBackup(configPath);
      expect(result).toBeNull();
    });
  });

  it("returns the first valid backup (.bak)", async () => {
    await withTempHome("backup-rollback-", async (home) => {
      const configPath = await setupConfigDir(home);
      const goodConfig = { gateway: { port: 18789 } };

      await fs.writeFile(configPath, "BROKEN", "utf-8");
      await fs.writeFile(`${configPath}.bak`, JSON.stringify(goodConfig), "utf-8");

      const result = await tryLoadValidConfigBackup(configPath);
      expect(result).not.toBeNull();
      expect(result!.backupPath).toBe(`${configPath}.bak`);
      expect(result!.snapshot.valid).toBe(true);
      expect(result!.snapshot.config.gateway?.port).toBe(18789);
    });
  });

  it("skips invalid backups and finds the next valid one", async () => {
    await withTempHome("backup-rollback-", async (home) => {
      const configPath = await setupConfigDir(home);
      const goodConfig = { gateway: { port: 18789 } };

      await fs.writeFile(configPath, "BROKEN", "utf-8");
      await fs.writeFile(`${configPath}.bak`, "ALSO_BROKEN", "utf-8");
      await fs.writeFile(`${configPath}.bak.1`, JSON.stringify(goodConfig), "utf-8");

      const result = await tryLoadValidConfigBackup(configPath);
      expect(result).not.toBeNull();
      expect(result!.backupPath).toBe(`${configPath}.bak.1`);
      expect(result!.snapshot.config.gateway?.port).toBe(18789);
    });
  });

  it("returns null when all backups are invalid", async () => {
    await withTempHome("backup-rollback-", async (home) => {
      const configPath = await setupConfigDir(home);

      await fs.writeFile(configPath, "BROKEN", "utf-8");
      await fs.writeFile(`${configPath}.bak`, "BROKEN_TOO", "utf-8");
      await fs.writeFile(`${configPath}.bak.1`, '{"also": }', "utf-8");

      const result = await tryLoadValidConfigBackup(configPath);
      expect(result).toBeNull();
    });
  });
});
