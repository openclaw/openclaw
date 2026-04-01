import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeEnv } from "../runtime.js";
import { createTempHomeEnv, type TempHomeEnv } from "../test-utils/temp-home.js";
import { backupRestoreCommand } from "./backup-restore.js";
import { backupCreateCommand } from "./backup.js";

const backupVerifyCommandMock = vi.hoisted(() => vi.fn());

vi.mock("./backup-verify.js", () => ({
  backupVerifyCommand: backupVerifyCommandMock,
}));

describe("backupRestoreCommand", () => {
  let tempHome: TempHomeEnv;

  async function resetTempHome() {
    await fs.rm(tempHome.home, { recursive: true, force: true });
    await fs.mkdir(path.join(tempHome.home, ".openclaw"), { recursive: true });
    delete process.env.OPENCLAW_CONFIG_PATH;
  }

  function createRuntime(): RuntimeEnv {
    return {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    } satisfies RuntimeEnv;
  }

  async function createTestBackup(): Promise<string> {
    const stateDir = path.join(tempHome.home, ".openclaw");
    await fs.writeFile(path.join(stateDir, "openclaw.json"), JSON.stringify({}), "utf8");
    await fs.writeFile(path.join(stateDir, "state.txt"), "state-data\n", "utf8");

    const backupDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-restore-cmd-test-"));
    const runtime = createRuntime();
    const result = await backupCreateCommand(runtime, {
      output: backupDir,
      includeWorkspace: true,
    });
    return result.archivePath;
  }

  beforeAll(async () => {
    tempHome = await createTempHomeEnv("openclaw-restore-cmd-test-");
  });

  beforeEach(async () => {
    await resetTempHome();
    backupVerifyCommandMock.mockReset();
    backupVerifyCommandMock.mockResolvedValue({ ok: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await tempHome.restore();
  });

  it("throws when restore would overwrite without --force", async () => {
    const archivePath = await createTestBackup();

    const runtime = createRuntime();

    try {
      await expect(backupRestoreCommand(runtime, { archive: archivePath })).rejects.toThrow(
        /overwrite existing paths/i,
      );
    } finally {
      await fs.rm(path.dirname(archivePath), { recursive: true, force: true });
    }
  });

  it("outputs JSON when --json is set", async () => {
    const archivePath = await createTestBackup();
    const stateDir = path.join(tempHome.home, ".openclaw");
    await fs.rm(stateDir, { recursive: true, force: true });

    const runtime = createRuntime();

    try {
      const result = await backupRestoreCommand(runtime, {
        archive: archivePath,
        json: true,
      });

      expect(runtime.log).toHaveBeenCalledWith(expect.stringContaining("{"));
      expect(result.restoredCount).toBeGreaterThan(0);
    } finally {
      await fs.rm(path.dirname(archivePath), { recursive: true, force: true });
    }
  });

  it("dry-run returns plan without writing", async () => {
    const archivePath = await createTestBackup();
    const stateDir = path.join(tempHome.home, ".openclaw");
    await fs.rm(stateDir, { recursive: true, force: true });

    const runtime = createRuntime();

    try {
      const result = await backupRestoreCommand(runtime, {
        archive: archivePath,
        dryRun: true,
      });

      expect(result.dryRun).toBe(true);
      expect(result.restoredCount).toBe(0);
      // State should still not exist
      expect(
        await fs
          .stat(stateDir)
          .then(() => true)
          .catch(() => false),
      ).toBe(false);
    } finally {
      await fs.rm(path.dirname(archivePath), { recursive: true, force: true });
    }
  });

  it("restores successfully with --force when conflicts exist", async () => {
    const archivePath = await createTestBackup();
    const stateDir = path.join(tempHome.home, ".openclaw");

    const runtime = createRuntime();

    try {
      const result = await backupRestoreCommand(runtime, {
        archive: archivePath,
        force: true,
      });

      expect(result.restoredCount).toBeGreaterThan(0);
      expect(result.force).toBe(true);

      // Verify state was restored
      const restoredState = await fs.readFile(path.join(stateDir, "state.txt"), "utf8");
      expect(restoredState).toBe("state-data\n");
    } finally {
      await fs.rm(path.dirname(archivePath), { recursive: true, force: true });
      // Clean up pre-restore snapshots
      const parentEntries = await fs.readdir(path.dirname(stateDir));
      for (const entry of parentEntries) {
        if (entry.includes(".pre-restore-")) {
          await fs.rm(path.join(path.dirname(stateDir), entry), {
            recursive: true,
            force: true,
          });
        }
      }
    }
  });
});
