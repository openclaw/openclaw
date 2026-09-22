import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  createBackupScratchDirectory,
  finishBackupScratch,
  maintainBackupScratch,
} from "./backup-scratch.js";
import * as fsSafe from "./fs-safe.js";
import * as nodeSqlite from "./node-sqlite.js";
import * as stagingToken from "./sqlite-staging-token.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

it.each(["lstat", "boundary", "cleanup"] as const)(
  "records scratch reclaimed before %s as an intentional non-outcome",
  async (phase) => {
    const root = dirs.make("backup-scratch-vanished-");
    const directory = path.join(root, "openclaw-backup-retired-Gone01");
    await fs.mkdir(directory);
    let removed = false;
    const reclaim = async (target: unknown) => {
      if (target === directory && !removed) {
        removed = true;
        await fs.rm(directory, { recursive: true });
      }
    };
    if (phase === "boundary") {
      const createRoot = fsSafe.root;
      vi.spyOn(fsSafe, "root").mockImplementation(async (...args) => {
        await reclaim(args[0]);
        return createRoot(...args);
      });
    } else if (phase === "lstat") {
      const lstat = fs.lstat;
      vi.spyOn(fs, "lstat").mockImplementation(async (...args) => {
        await reclaim(args[0]);
        return lstat(...args);
      });
    } else {
      const rmdir = fs.rmdir;
      vi.spyOn(fs, "rmdir").mockImplementation(async (...args) => {
        await reclaim(args[0]);
        return rmdir(...args);
      });
    }
    const log = vi.fn();
    const report = await maintainBackupScratch({ roots: [root], repair: true, log });
    expect(removed).toBe(true);
    expect(report.warnings).toEqual([]);
    expect(report.reclaimed).toEqual([]);
    expect(report.alreadyReclaimed).toEqual([directory]);
    expect(log).toHaveBeenCalledWith(`Backup scratch already reclaimed: ${directory}`);
  },
);

it.each(["directory", "token"] as const)(
  "reports native token-open failure according to remaining scratch (%s removed)",
  async (removed) => {
    const root = dirs.make("backup-scratch-token-vanished-");
    const { directory, release } = await createBackupScratchDirectory(root);
    release(true);
    const tokenPath = path.join(directory, stagingToken.SQLITE_STAGING_TOKEN_FILES[0]);
    const tokenLocation = nodeSqlite.resolveExistingSqliteFileUri(tokenPath);
    const open = nodeSqlite.openNodeSqliteDatabase;
    let nativeFailure: unknown;
    vi.spyOn(nodeSqlite, "openNodeSqliteDatabase").mockImplementation((...args) => {
      if (args[0] !== tokenLocation) {
        return open(...args);
      }
      fsSync.rmSync(removed === "directory" ? directory : tokenPath, { recursive: true });
      try {
        return open(...args);
      } catch (error) {
        nativeFailure = error;
        throw error;
      }
    });
    const log = vi.fn();
    const report = await maintainBackupScratch({ roots: [root], repair: true, log });
    expect(nativeFailure).toBeInstanceOf(Error);
    expect(report.reclaimed).toEqual([]);
    expect(report.active).toEqual([]);
    if (removed === "directory") {
      expect(report.warnings).toEqual([]);
      expect(report.alreadyReclaimed).toEqual([directory]);
      expect(log).toHaveBeenCalledWith(`Backup scratch already reclaimed: ${directory}`);
    } else {
      expect(report.alreadyReclaimed).toEqual([]);
      expect(report.warnings).toEqual([
        expect.stringContaining(`Backup scratch preserved at ${directory}:`),
      ]);
      await expect(fs.stat(directory)).resolves.toBeDefined();
    }
  },
);

it("does not report remaining scratch as reclaimed when only a payload vanishes", async () => {
  const root = dirs.make("backup-scratch-payload-vanished-");
  const directory = path.join(root, "openclaw-backup-retired-Gone02");
  await fs.mkdir(directory);
  const payload = path.join(directory, "config-0");
  await fs.writeFile(payload, "synthetic config");
  const lstat = fs.lstat;
  vi.spyOn(fs, "lstat").mockImplementation(async (...args) => {
    if (args[0] === payload) {
      await fs.rm(payload, { force: true });
    }
    return lstat(...args);
  });
  const report = await maintainBackupScratch({ roots: [root], repair: true, log: () => {} });
  expect(report.reclaimed).toEqual([]);
  expect(report.alreadyReclaimed).toEqual([]);
  expect(report.warnings).toEqual([expect.stringContaining(directory)]);
  await expect(fs.stat(directory)).resolves.toBeDefined();
});

it("preserves a symlink target when scratch is replaced after transaction retirement", async () => {
  const parent = dirs.make("backup-scratch-replaced-");
  const scratch = await createBackupScratchDirectory(parent);
  await fs.writeFile(path.join(scratch.directory, "config-0"), "scratch");
  const outside = dirs.make("backup-scratch-protected-");
  const protectedFile = path.join(outside, "config-0");
  await fs.writeFile(protectedFile, "unrelated data");
  const release = scratch.release;
  scratch.release = Object.assign(
    (retiring?: boolean) => {
      release(retiring);
      if (retiring) {
        fsSync.renameSync(scratch.directory, `${scratch.directory}.original`);
        fsSync.symlinkSync(
          outside,
          scratch.directory,
          process.platform === "win32" ? "junction" : "dir",
        );
      }
    },
    {
      beginRetirement: () => {
        release.beginRetirement();
        return scratch.release;
      },
    },
  );
  await expect(finishBackupScratch(scratch, () => {})).resolves.toContain(scratch.directory);
  await expect(fs.readFile(protectedFile, "utf8")).resolves.toBe("unrelated data");
});

it("allocates fresh scratch if reclamation retires its token before admission", async () => {
  const root = dirs.make("backup-scratch-admission-");
  const acquire = stagingToken.acquireSqliteStagingToken;
  let retired: string | undefined;
  vi.spyOn(stagingToken, "acquireSqliteStagingToken").mockImplementation(
    (directory, mode, options) => {
      if (mode === "create" && !retired) {
        retired = directory;
        acquire(directory, "create")(true);
      }
      return acquire(directory, mode, options);
    },
  );
  const admitted = await createBackupScratchDirectory(root);
  try {
    expect(admitted.directory).not.toBe(retired);
    const report = await maintainBackupScratch({ roots: [root], repair: true });
    expect(report.reclaimed).toEqual([retired]);
    expect(report.active).toEqual([admitted.directory]);
  } finally {
    await finishBackupScratch(admitted);
  }
});

it("preserves unexpected contents and symbolic links instead of adopting them as scratch", async () => {
  const root = dirs.make("backup-scratch-unknown-");
  const unknown = await createBackupScratchDirectory(root);
  unknown.release();
  const archive = path.join(unknown.directory, "backup.tar.gz");
  await fs.writeFile(archive, "published backup");
  const linked = path.join(root, "openclaw-backup-linked");
  await fs.symlink(unknown.directory, linked, process.platform === "win32" ? "junction" : "dir");
  const report = await maintainBackupScratch({ roots: [root], repair: true });
  expect(report.reclaimed).toEqual([]);
  expect(report.warnings).toHaveLength(2);
  expect(report.warnings).toEqual(
    expect.arrayContaining([expect.stringContaining(archive), expect.stringContaining(linked)]),
  );
  await expect(fs.readFile(archive, "utf8")).resolves.toBe("published backup");
  await expect(fs.lstat(linked)).resolves.toSatisfy((entry) => entry.isSymbolicLink());
});

it("reclaims abandoned scratch while a live transaction protects its files", async () => {
  const root = dirs.make("backup-scratch-lifetime-");
  const abandoned = await createBackupScratchDirectory(root);
  const active = await createBackupScratchDirectory(root);
  const legacy = path.join(root, "openclaw-backup-Legacy");
  const rollback = path.join(root, ".openclaw.package-backup-123-456");
  for (const directory of [abandoned.directory, active.directory, legacy, rollback]) {
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, "config-0"), "synthetic backup input");
  }
  abandoned.release();
  try {
    const inspection = await maintainBackupScratch({ roots: [root], repair: false });
    expect(inspection.reclaimed).toEqual([]);
    expect(inspection.unchecked).toEqual(
      expect.arrayContaining([active.directory, abandoned.directory]),
    );
    await expect(fs.readFile(path.join(abandoned.directory, "config-0"), "utf8")).resolves.toBe(
      "synthetic backup input",
    );

    const repair = await maintainBackupScratch({ roots: [root], repair: true });
    expect(repair.reclaimed).toEqual([abandoned.directory]);
    expect(repair.active).toEqual([active.directory]);
    expect(repair.warnings).toEqual([expect.stringContaining(legacy)]);
    await expect(fs.stat(abandoned.directory)).rejects.toMatchObject({ code: "ENOENT" });
    for (const directory of [active.directory, legacy, rollback]) {
      await expect(fs.readFile(path.join(directory, "config-0"), "utf8")).resolves.toBe(
        "synthetic backup input",
      );
    }
  } finally {
    await finishBackupScratch(active);
  }
});

it.each(["payload", "directory"] as const)(
  "retries retirement after failed %s cleanup",
  async (phase) => {
    const root = dirs.make("backup-scratch-retry-");
    const scratch = await createBackupScratchDirectory(root);
    const payload = path.join(scratch.directory, "config-0");
    await fs.writeFile(payload, "synthetic config");
    const method = phase === "payload" ? "unlink" : "rmdir";
    const remove = fs[method].bind(fs);
    const failure = vi.spyOn(fs, method).mockImplementation(async (target) => {
      if (
        (phase === "payload" && path.basename(String(target)) === "config-0") ||
        (phase === "directory" && path.dirname(String(target)) === root)
      ) {
        throw Object.assign(new Error("cleanup denied"), { code: "EACCES" });
      }
      return remove(target);
    });
    let remaining = scratch.directory;
    try {
      const log = vi.fn();
      const warning = await finishBackupScratch(scratch, log);
      const [retired] = await fs.readdir(root);
      remaining = path.join(root, retired!);
      expect(warning).toContain(remaining);
      expect(log).toHaveBeenCalledWith(expect.stringContaining("cleanup denied"));
      const token = fs.stat(path.join(remaining, "owner.sqlite"));
      if (phase === "payload") {
        await expect(token).resolves.toBeDefined();
      } else {
        await expect(token).rejects.toMatchObject({ code: "ENOENT" });
      }
    } finally {
      failure.mockRestore();
    }
    const report = await maintainBackupScratch({ roots: [root], repair: true });
    expect(report.reclaimed).toEqual([remaining]);
    await expect(fs.stat(remaining)).rejects.toMatchObject({ code: "ENOENT" });
  },
);
