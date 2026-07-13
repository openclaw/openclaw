// Covers config backup rotation limits and cleanup behavior.
import fs from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { createPreUpdateConfigSnapshot, maintainConfigBackups } from "./backup-rotation.js";
import {
  expectPosixMode,
  IS_WINDOWS,
  resolveConfigPathFromTempState,
} from "./config.backup-rotation.test-helpers.js";
import { withTempHome } from "./test-helpers.js";

async function expectRegularFile(filePath: string): Promise<void> {
  expect((await fs.stat(filePath)).isFile()).toBe(true);
}

async function expectPathMissing(filePath: string): Promise<void> {
  let error: { code?: unknown } | undefined;
  try {
    await fs.stat(filePath);
  } catch (err) {
    error = err as { code?: unknown };
  }
  expect(error?.code).toBe("ENOENT");
}

describe("config backup rotation", () => {
  it("maintainConfigBackups composes rotate/copy/harden/prune flow", async () => {
    await withTempHome(async () => {
      const configPath = resolveConfigPathFromTempState();
      await fs.writeFile(configPath, JSON.stringify({ token: "secret" }), { mode: 0o600 });
      await fs.writeFile(`${configPath}.bak`, "previous", { mode: 0o644 });
      await fs.writeFile(`${configPath}.bak.orphan`, "old");

      await maintainConfigBackups(configPath, fs);

      // A new primary backup is created from the current config.
      await expect(fs.readFile(`${configPath}.bak`, "utf-8")).resolves.toBe(
        JSON.stringify({ token: "secret" }),
      );
      // Prior primary backup gets rotated into ring slot 1.
      await expect(fs.readFile(`${configPath}.bak.1`, "utf-8")).resolves.toBe("previous");
      // Windows cannot validate POSIX chmod bits, but all other compose assertions
      // should still run there.
      if (!IS_WINDOWS) {
        const primaryBackupStat = await fs.stat(`${configPath}.bak`);
        expectPosixMode(primaryBackupStat.mode, 0o600);
      }
      // Out-of-ring orphan gets pruned.
      await expectPathMissing(`${configPath}.bak.orphan`);
    });
  });

  it("createPreUpdateConfigSnapshot writes .pre-update outside rotation ring", async () => {
    await withTempHome(async () => {
      const configPath = resolveConfigPathFromTempState();
      const content = JSON.stringify({ plugins: { installs: ["matrix"] } });
      await fs.writeFile(configPath, content, { mode: 0o600 });

      const { existsSync } = await import("node:fs");
      await createPreUpdateConfigSnapshot({
        configPath,
        fs: { writeFile: fs.writeFile, readFile: fs.readFile, existsSync },
      });

      const snapshotPath = `${configPath}.pre-update`;
      await expectRegularFile(snapshotPath);
      await expect(fs.readFile(snapshotPath, "utf-8")).resolves.toBe(content);
      if (!IS_WINDOWS) {
        const stat = await fs.stat(snapshotPath);
        expectPosixMode(stat.mode, 0o600);
      }
    });
  });

  it("createPreUpdateConfigSnapshot replaces a preexisting snapshot once per process", async () => {
    await withTempHome(async () => {
      const configPath = resolveConfigPathFromTempState();
      const stale = JSON.stringify({ snapshot: "stale" });
      const current = JSON.stringify({ snapshot: "current" });
      const second = JSON.stringify({ snapshot: "second" });
      const snapshotPath = `${configPath}.pre-update`;
      await fs.writeFile(configPath, current, { mode: 0o600 });
      await fs.writeFile(snapshotPath, stale, { mode: 0o600 });

      const { existsSync } = await import("node:fs");
      await createPreUpdateConfigSnapshot({
        configPath,
        fs: { writeFile: fs.writeFile, readFile: fs.readFile, existsSync },
      });
      await expect(fs.readFile(snapshotPath, "utf-8")).resolves.toBe(current);

      // Later writes in the same update attempt should not replace the first snapshot.
      await fs.writeFile(configPath, second);
      await createPreUpdateConfigSnapshot({
        configPath,
        fs: { writeFile: fs.writeFile, readFile: fs.readFile, existsSync },
      });
      await expect(fs.readFile(snapshotPath, "utf-8")).resolves.toBe(current);
    });
  });

  it("createPreUpdateConfigSnapshot is a no-op when config does not exist", async () => {
    await withTempHome(async () => {
      const configPath = resolveConfigPathFromTempState();
      const { existsSync } = await import("node:fs");

      await createPreUpdateConfigSnapshot({
        configPath,
        fs: { writeFile: fs.writeFile, readFile: fs.readFile, existsSync },
      });

      await expectPathMissing(`${configPath}.pre-update`);
    });
  });
});
