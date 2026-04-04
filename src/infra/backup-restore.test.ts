import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { backupCreateCommand } from "../commands/backup.js";
import type { RuntimeEnv } from "../runtime.js";
import { createTempHomeEnv, type TempHomeEnv } from "../test-utils/temp-home.js";
import { executeRestore, formatBackupRestoreSummary, planRestore } from "./backup-restore.js";

const backupVerifyCommandMock = vi.hoisted(() => vi.fn());

vi.mock("../commands/backup-verify.js", () => ({
  backupVerifyCommand: backupVerifyCommandMock,
}));

describe("backup restore", () => {
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

  async function createTestBackup(stateDir: string): Promise<string> {
    await fs.writeFile(path.join(stateDir, "openclaw.json"), JSON.stringify({}), "utf8");
    await fs.writeFile(path.join(stateDir, "state.txt"), "state-data\n", "utf8");
    await fs.mkdir(path.join(stateDir, "credentials"), { recursive: true });
    await fs.writeFile(path.join(stateDir, "credentials", "oauth.json"), '{"token":"abc"}', "utf8");

    const backupDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-restore-test-backup-"));
    const runtime = createRuntime();
    const result = await backupCreateCommand(runtime, {
      output: backupDir,
      includeWorkspace: true,
    });
    return result.archivePath;
  }

  beforeAll(async () => {
    tempHome = await createTempHomeEnv("openclaw-restore-test-");
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

  it("plans a restore with no conflicts when target does not exist", async () => {
    const stateDir = path.join(tempHome.home, ".openclaw");
    const archivePath = await createTestBackup(stateDir);

    // Remove state so there is no conflict
    await fs.rm(stateDir, { recursive: true, force: true });

    const plan = await planRestore({ archive: archivePath });

    expect(plan.archivePath).toBe(archivePath);
    expect(plan.assets.length).toBeGreaterThan(0);
    expect(plan.assets.every((a) => !a.conflict)).toBe(true);
    expect(plan.dryRun).toBe(false);

    await fs.rm(path.dirname(archivePath), { recursive: true, force: true });
  });

  it("detects conflicts when target paths already exist", async () => {
    const stateDir = path.join(tempHome.home, ".openclaw");
    const archivePath = await createTestBackup(stateDir);

    // State dir still exists — should detect conflict
    const plan = await planRestore({ archive: archivePath });

    expect(plan.assets.length).toBeGreaterThan(0);
    expect(plan.assets.some((a) => a.conflict)).toBe(true);

    await fs.rm(path.dirname(archivePath), { recursive: true, force: true });
  });

  it("round-trip: backup then restore produces identical files", async () => {
    const stateDir = path.join(tempHome.home, ".openclaw");
    const archivePath = await createTestBackup(stateDir);

    // Save original contents
    const originalState = await fs.readFile(path.join(stateDir, "state.txt"), "utf8");
    const originalOauth = await fs.readFile(
      path.join(stateDir, "credentials", "oauth.json"),
      "utf8",
    );

    // Remove state to simulate loss
    await fs.rm(stateDir, { recursive: true, force: true });
    expect(
      await fs
        .stat(stateDir)
        .then(() => true)
        .catch(() => false),
    ).toBe(false);

    // Restore
    const plan = await planRestore({ archive: archivePath });
    expect(plan.assets.every((a) => !a.conflict)).toBe(true);

    const restoredCount = await executeRestore(plan, { archive: archivePath });
    expect(restoredCount).toBeGreaterThan(0);

    // Verify restored files match originals
    const restoredState = await fs.readFile(path.join(stateDir, "state.txt"), "utf8");
    const restoredOauth = await fs.readFile(
      path.join(stateDir, "credentials", "oauth.json"),
      "utf8",
    );

    expect(restoredState).toBe(originalState);
    expect(restoredOauth).toBe(originalOauth);

    await fs.rm(path.dirname(archivePath), { recursive: true, force: true });
  });

  it("--force renames existing state before restoring", async () => {
    const stateDir = path.join(tempHome.home, ".openclaw");
    const archivePath = await createTestBackup(stateDir);

    // Modify the existing state to distinguish it from the backup
    await fs.writeFile(path.join(stateDir, "state.txt"), "modified-state\n", "utf8");

    const plan = await planRestore({ archive: archivePath, force: true });
    expect(plan.assets.some((a) => a.conflict)).toBe(true);

    await executeRestore(plan, { archive: archivePath, force: true });

    // Original state should be renamed to .pre-restore-*
    const parentEntries = await fs.readdir(path.dirname(stateDir));
    const preRestoreEntries = parentEntries.filter((e) => e.includes(".pre-restore-"));
    expect(preRestoreEntries.length).toBeGreaterThan(0);

    // Restored state should have original backup content
    const restoredState = await fs.readFile(path.join(stateDir, "state.txt"), "utf8");
    expect(restoredState).toBe("state-data\n");

    // Pre-restore snapshot should have the modified content
    const snapshotDir = path.join(path.dirname(stateDir), preRestoreEntries[0]);
    const snapshotState = await fs.readFile(path.join(snapshotDir, "state.txt"), "utf8");
    expect(snapshotState).toBe("modified-state\n");

    await fs.rm(path.dirname(archivePath), { recursive: true, force: true });
    await fs.rm(snapshotDir, { recursive: true, force: true });
  });

  it("dry-run does not write any files", async () => {
    const stateDir = path.join(tempHome.home, ".openclaw");
    const archivePath = await createTestBackup(stateDir);

    // Remove state
    await fs.rm(stateDir, { recursive: true, force: true });

    const plan = await planRestore({ archive: archivePath, dryRun: true });
    expect(plan.dryRun).toBe(true);

    // State should still not exist (dry run, no executeRestore called)
    expect(
      await fs
        .stat(stateDir)
        .then(() => true)
        .catch(() => false),
    ).toBe(false);

    await fs.rm(path.dirname(archivePath), { recursive: true, force: true });
  });

  it("throws on empty archive", async () => {
    const emptyArchive = path.join(os.tmpdir(), `openclaw-empty-${Date.now()}.tar.gz`);
    // Create minimal empty gzip tar
    const { createGzip } = await import("node:zlib");
    const { createWriteStream } = await import("node:fs");
    const { pipeline } = await import("node:stream/promises");
    const { Readable } = await import("node:stream");

    await pipeline(Readable.from(Buffer.alloc(0)), createGzip(), createWriteStream(emptyArchive));

    try {
      await expect(planRestore({ archive: emptyArchive })).rejects.toThrow(/empty/i);
    } finally {
      await fs.rm(emptyArchive, { force: true });
    }
  });

  it("formatBackupRestoreSummary produces readable output", () => {
    const result = {
      archivePath: "/tmp/backup.tar.gz",
      archiveRoot: "2026-04-01T00-00-00.000Z-openclaw-backup",
      createdAt: "2026-04-01T00:00:00.000Z",
      runtimeVersion: "2026.3.28",
      platform: "linux",
      dryRun: false,
      force: false,
      assets: [
        {
          kind: "state",
          archivePath: "root/payload/posix/home/coder/.openclaw",
          originalSourcePath: "/home/coder/.openclaw",
          restorePath: "/home/coder/.openclaw",
          displayPath: "~/.openclaw",
          conflict: false,
        },
      ],
      restoredCount: 1,
    };

    const lines = formatBackupRestoreSummary(result);
    const output = lines.join("\n");
    expect(output).toContain("/tmp/backup.tar.gz");
    expect(output).toContain("state");
    expect(output).toContain("~/.openclaw");
    expect(output).toContain("Restored 1 path");
  });

  it("formatBackupRestoreSummary shows conflicts in dry-run mode", () => {
    const result = {
      archivePath: "/tmp/backup.tar.gz",
      archiveRoot: "root",
      createdAt: "2026-04-01T00:00:00.000Z",
      runtimeVersion: "2026.3.28",
      platform: "linux",
      dryRun: true,
      force: false,
      assets: [
        {
          kind: "state",
          archivePath: "root/payload/posix/home/coder/.openclaw",
          originalSourcePath: "/home/coder/.openclaw",
          restorePath: "/home/coder/.openclaw",
          displayPath: "~/.openclaw",
          conflict: true,
        },
      ],
      restoredCount: 0,
    };

    const lines = formatBackupRestoreSummary(result);
    const output = lines.join("\n");
    expect(output).toContain("conflict");
    expect(output).toContain("Dry run");
    expect(output).toContain("--force");
  });
});
