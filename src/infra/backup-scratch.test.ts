import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { __setFsSafeTestHooksForTest } from "@openclaw/fs-safe/test-hooks";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  createBackupScratchDirectory,
  finishBackupScratch,
  maintainBackupScratch,
} from "./backup-scratch.js";
import * as fsSafe from "./fs-safe.js";
import * as nodeSqlite from "./node-sqlite.js";
import * as privateDirectory from "./sqlite-private-directory.js";
import * as stagingToken from "./sqlite-staging-token.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  __setFsSafeTestHooksForTest(undefined);
  vi.restoreAllMocks();
});

it.each([false, true])(
  "coordinates a scratch creator awaiting lifetime admission (repair=%s)",
  async (repair) => {
    const root = dirs.make("backup-scratch-creation-");
    const entered = createDeferredCore<string>();
    const resume = createDeferredCore();
    const createDirectory = privateDirectory.createPrivateSqliteTempDirectory;
    let paused = false;
    vi.spyOn(privateDirectory, "createPrivateSqliteTempDirectory").mockImplementation(
      async (...args) => {
        const directory = await createDirectory(...args);
        if (!paused && args[0] === root) {
          paused = true;
          entered.resolve(directory);
          await resume.promise;
        }
        return directory;
      },
    );
    const creating = createBackupScratchDirectory(root);
    try {
      const originalDirectory = await entered.promise;
      const report = await maintainBackupScratch({ roots: [root], repair, log: () => {} });
      expect(report.warnings).toEqual([]);
      expect(repair ? report.reclaimed : report.unchecked).toEqual([originalDirectory]);
      resume.resolve();
      const scratch = await creating;
      expect(scratch.directory === originalDirectory).toBe(!repair);
      const active = await maintainBackupScratch({ roots: [root], repair: true, log: () => {} });
      expect(active.warnings).toEqual([]);
      expect(active.active).toEqual([scratch.directory]);
    } finally {
      resume.resolve();
      await expect(finishBackupScratch(await creating, () => {})).resolves.toBeUndefined();
    }
  },
);

it.each(["reclaimed", "replaced"] as const)(
  "recovers only reclaimed scratch after boundary observation (%s)",
  async (change) => {
    const root = await fs.realpath(dirs.make("backup-scratch-observation-"));
    const entered = createDeferredCore<string>();
    const resume = createDeferredCore();
    __setFsSafeTestHooksForTest({
      beforeRootStatObservation: async (target) => {
        if (
          path.dirname(target) !== root ||
          !path.basename(target).startsWith("openclaw-backup-owned-")
        ) {
          return;
        }
        __setFsSafeTestHooksForTest(undefined);
        entered.resolve(target);
        await resume.promise;
      },
    });
    const creating = createBackupScratchDirectory(root);
    // The held creator can reject before the assertion joins its outcome.
    void creating.catch(() => {});
    let scratch: Awaited<typeof creating> | undefined;
    try {
      const originalDirectory = await entered.promise;
      const moved = path.join(root, "original-directory");
      const sentinel = path.join(originalDirectory, "sentinel");
      if (change === "reclaimed") {
        const report = await maintainBackupScratch({ roots: [root], repair: true, log: () => {} });
        expect(report.reclaimed).toEqual([originalDirectory]);
        expect(report.warnings).toEqual([]);
        await expect(fs.lstat(originalDirectory)).rejects.toMatchObject({ code: "ENOENT" });
      } else {
        await fs.rename(originalDirectory, moved);
        await fs.mkdir(originalDirectory);
        await fs.writeFile(sentinel, "replacement remains owned by its creator");
      }
      resume.resolve();
      if (change === "reclaimed") {
        scratch = await creating;
        expect(scratch.directory).not.toBe(originalDirectory);
        const active = await maintainBackupScratch({ roots: [root], repair: true, log: () => {} });
        expect(active.warnings).toEqual([]);
        expect(active.active).toEqual([scratch.directory]);
      } else {
        await expect(creating).rejects.toMatchObject({ code: "path-mismatch" });
        await expect(fs.readFile(sentinel, "utf8")).resolves.toBe(
          "replacement remains owned by its creator",
        );
        expect((await fs.stat(moved)).isDirectory()).toBe(true);
      }
    } finally {
      __setFsSafeTestHooksForTest(undefined);
      resume.resolve();
      scratch ??= await creating.catch(() => undefined);
      if (scratch) {
        await expect(finishBackupScratch(scratch, () => {})).resolves.toBeUndefined();
      }
    }
  },
);

it.each([false, true])(
  "retries a creator's native token-open failure only when its directory was reclaimed (%s)",
  async (reclaimed) => {
    const root = dirs.make("backup-scratch-create-open-");
    const open = nodeSqlite.openNodeSqliteDatabase;
    let failedDirectory: string | undefined;
    let nativeFailure: unknown;
    vi.spyOn(nodeSqlite, "openNodeSqliteDatabase").mockImplementation((location, options) => {
      if (failedDirectory) {
        return open(location, options);
      }
      failedDirectory = path.dirname(location);
      if (reclaimed) {
        fsSync.rmSync(failedDirectory, { recursive: true });
      }
      try {
        return open(
          reclaimed ? location : path.join(failedDirectory, "missing", "owner.sqlite"),
          options,
        );
      } catch (error) {
        nativeFailure = error;
        throw error;
      }
    });
    let scratch: Awaited<ReturnType<typeof createBackupScratchDirectory>> | undefined;
    try {
      const outcome = await createBackupScratchDirectory(root).then(
        (value) => ({ scratch: value }),
        (failure: unknown) => ({ failure }),
      );
      scratch = "scratch" in outcome ? outcome.scratch : undefined;
      const failure = "failure" in outcome ? outcome.failure : undefined;
      expect(nativeFailure).toBeInstanceOf(Error);
      if (reclaimed) {
        expect(failure).toBeUndefined();
        expect(scratch?.directory).toBeDefined();
        expect(scratch?.directory).not.toBe(failedDirectory);
      } else {
        expect(failure).toBe(nativeFailure);
        expect(scratch).toBeUndefined();
      }
    } finally {
      if (scratch) {
        await expect(finishBackupScratch(scratch, () => {})).resolves.toBeUndefined();
      }
    }
  },
);

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

it.each(["admitted", "creating"] as const)(
  "classifies active scratch before inspecting a journal that can disappear (%s)",
  async (phase) => {
    const root = dirs.make("backup-scratch-active-journal-");
    const entered = createDeferredCore<string>();
    const resume = createDeferredCore();
    if (phase === "creating") {
      const createDirectory = privateDirectory.createPrivateSqliteTempDirectory;
      vi.spyOn(privateDirectory, "createPrivateSqliteTempDirectory").mockImplementation(
        async (...args) => {
          const directory = await createDirectory(...args);
          entered.resolve(directory);
          await resume.promise;
          return directory;
        },
      );
    }
    const creating = createBackupScratchDirectory(root);
    const directory = phase === "creating" ? await entered.promise : (await creating).directory;
    const snapshot = path.join(directory, ".sqlite-snapshot-Active");
    const journal = path.join(snapshot, "database.sqlite-journal");
    let database: ReturnType<typeof nodeSqlite.openNodeSqliteDatabase> | undefined;
    const startSnapshot = () => {
      fsSync.mkdirSync(snapshot);
      const opened = nodeSqlite.openNodeSqliteDatabase(path.join(snapshot, "database.sqlite"));
      database = opened;
      opened.exec(
        "PRAGMA journal_mode = DELETE; CREATE TABLE fixture (id INTEGER); BEGIN IMMEDIATE; INSERT INTO fixture VALUES (1);",
      );
      expect(fsSync.existsSync(journal)).toBe(true);
    };
    const lstat = fs.lstat;
    let inspectedJournal = false;
    let observedMissingToken = false;
    const inspect = vi.spyOn(fs, "lstat").mockImplementation(async (...args) => {
      if (
        phase === "creating" &&
        args[0] === path.join(directory, stagingToken.SQLITE_STAGING_TOKEN_FILES[0]) &&
        !observedMissingToken
      ) {
        try {
          return await lstat(...args);
        } catch (error) {
          expect(error).toMatchObject({ code: "ENOENT" });
          observedMissingToken = true;
          resume.resolve();
          await creating;
          startSnapshot();
          throw error;
        }
      }
      if (args[0] === journal) {
        inspectedJournal = true;
        // A live snapshot can commit between the maintainer's readdir and lstat.
        database?.exec("COMMIT");
      }
      return lstat(...args);
    });
    try {
      if (phase === "admitted") {
        startSnapshot();
      }
      const report = await maintainBackupScratch({ roots: [root], repair: true, log: () => {} });
      expect(observedMissingToken).toBe(phase === "creating");
      expect(report.warnings).toEqual([]);
      expect(report.active).toEqual([directory]);
      expect(report.reclaimed).toEqual([]);
      expect(report.alreadyReclaimed).toEqual([]);
      expect(inspectedJournal).toBe(false);
      expect(database?.isTransaction).toBe(true);
    } finally {
      inspect.mockRestore();
      resume.resolve();
      if (database?.isTransaction) {
        database.exec("ROLLBACK");
      }
      database?.close();
      await finishBackupScratch(await creating);
    }
  },
);

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
