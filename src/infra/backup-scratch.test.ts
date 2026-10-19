import crypto from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { __setFsSafeTestHooksForTest } from "@openclaw/fs-safe/test-hooks";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  createBackupScratchDirectory as createScratch,
  finishBackupScratch as finishScratch,
  maintainBackupScratch,
} from "./backup-scratch.js";
import * as fsSafe from "./fs-safe.js";
import * as sqlite from "./node-sqlite.js";
import * as privateDirs from "./sqlite-private-directory.js";
import * as tokens from "./sqlite-staging-token.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
const linkType = process.platform === "win32" ? "junction" : "dir";
afterEach(() => {
  __setFsSafeTestHooksForTest(undefined);
  vi.restoreAllMocks();
});

function inspect(root: string, repair = true, log?: (message: string) => void) {
  return maintainBackupScratch({ roots: [root], repair, log });
}

function pauseCreation(root: string) {
  const entered = createDeferredCore<string>();
  const resume = createDeferredCore();
  const create = privateDirs.createPrivateSqliteTempDirectory;
  let paused = false;
  vi.spyOn(privateDirs, "createPrivateSqliteTempDirectory").mockImplementation(async (...args) => {
    const directory = await create(...args);
    if (!paused && args[0] === root) {
      paused = true;
      entered.resolve(directory);
      await resume.promise;
    }
    return directory;
  });
  return { entered, resume };
}

function expectContents(file: string, contents: string) {
  return expect(fs.readFile(file, "utf8")).resolves.toBe(contents);
}

it("inspects a scratch creator awaiting lifetime admission without reclaiming it", async () => {
  const root = dirs.make("backup-scratch-creation-");
  const { entered, resume } = pauseCreation(root);
  const creating = createScratch(root);
  try {
    const originalDirectory = await entered.promise;
    const report = await maintainBackupScratch({ roots: [root], repair: false, log: () => {} });
    expect(report.warnings).toEqual([]);
    expect(report.unchecked).toEqual([originalDirectory]);
    resume.resolve();
    const scratch = await creating;
    expect(scratch.directory).toBe(originalDirectory);
    const active = await maintainBackupScratch({ roots: [root], repair: true, log: () => {} });
    expect(active.warnings).toEqual([]);
    expect(active.active).toEqual([scratch.directory]);
  } finally {
    resume.resolve();
    await expect(finishScratch(await creating, () => {})).resolves.toBeUndefined();
  }
  await expect(fs.readdir(root)).resolves.toEqual([]);
});

it("reclaims scratch when the platform cannot rename onto an existing directory", async () => {
  const root = await fs.realpath(dirs.make("backup-scratch-windows-"));
  const scratch = await createScratch(root);
  await fs.writeFile(path.join(scratch.directory, "config-0"), "synthetic config");
  const nativePlatform = process.platform;
  const platform = vi.spyOn(process, "platform", "get").mockReturnValue(nativePlatform);
  const createRoot = fsSafe.root;
  // Keep filesystem admission native; emulate Windows only at the retirement move.
  vi.spyOn(fsSafe, "root").mockImplementation(async (...args) => {
    const boundary = await createRoot(...args);
    if (args[0] === root) {
      platform.mockReturnValue("win32");
      vi.spyOn(boundary, "move").mockImplementation(async (from, to, options) => {
        platform.mockReturnValue(nativePlatform);
        options?.assertBeforeMutation?.();
        const destination = path.join(root, to);
        if (fsSync.existsSync(destination)) {
          throw Object.assign(new Error("Windows cannot replace a directory"), { code: "EPERM" });
        }
        await fs.rename(path.join(root, from), destination);
      });
    }
    return boundary;
  });
  // A precreated target must reach EPERM even on hosts without Windows ACL helpers.
  vi.spyOn(privateDirs, "createPrivateSqliteTempDirectory").mockImplementation((parent, prefix) =>
    fs.mkdtemp(path.join(parent, prefix)),
  );
  const log = vi.fn();
  await expect(finishScratch(scratch, log)).resolves.toBeUndefined();
  expect(log).not.toHaveBeenCalled();
  await expect(fs.readdir(root)).resolves.toEqual([]);
});

it.runIf(process.platform === "win32")(
  "preserves an existing retirement destination without moving the owned scratch",
  async () => {
    const root = dirs.make("backup-scratch-collision-");
    const scratch = await createScratch(root);
    const id = crypto.randomUUID();
    const destination = path.join(root, `openclaw-backup-retired-${id}`);
    await fs.mkdir(destination);
    const before = await fs.lstat(destination, { bigint: true });
    vi.spyOn(crypto, "randomUUID").mockReturnValue(id);

    await expect(finishScratch(scratch, () => {})).resolves.toContain(scratch.directory);
    await expect(fs.stat(path.join(scratch.directory, "owner.sqlite"))).resolves.toBeDefined();
    await expect(fs.lstat(destination, { bigint: true })).resolves.toMatchObject({
      dev: before.dev,
      ino: before.ino,
    });
    await expect(fs.readdir(destination)).resolves.toEqual([]);
  },
);

it("rejects replaced scratch after boundary observation without removing either directory", async () => {
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
  const creating = createScratch(root);
  // The held creator can reject before the assertion joins its outcome.
  void creating.catch(() => {});
  try {
    const originalDirectory = await entered.promise;
    const moved = path.join(root, "original-directory");
    const sentinel = path.join(originalDirectory, "sentinel");
    await fs.rename(originalDirectory, moved);
    await fs.mkdir(originalDirectory);
    await fs.writeFile(sentinel, "replacement remains owned by its creator");
    resume.resolve();
    await expect(creating).rejects.toMatchObject({ code: "path-mismatch" });
    await expect(fs.readFile(sentinel, "utf8")).resolves.toBe(
      "replacement remains owned by its creator",
    );
    expect((await fs.stat(moved)).isDirectory()).toBe(true);
  } finally {
    __setFsSafeTestHooksForTest(undefined);
    resume.resolve();
    await creating.catch(() => {});
  }
});

it("cleans up scratch and preserves its original native token-open failure", async () => {
  const root = dirs.make("backup-scratch-create-open-");
  const open = sqlite.openNodeSqliteDatabase;
  const createDirectory = privateDirs.createPrivateSqliteTempDirectory;
  let nativeFailure: unknown;
  vi.spyOn(privateDirs, "createPrivateSqliteTempDirectory").mockImplementationOnce(
    async (...args) => {
      const directory = await createDirectory(...args);
      vi.spyOn(sqlite, "openNodeSqliteDatabase").mockImplementationOnce((_location, options) => {
        try {
          return open(path.join(directory, "missing", "owner.sqlite"), options);
        } catch (error) {
          nativeFailure = error;
          throw error;
        }
      });
      return directory;
    },
  );
  let scratch: Awaited<ReturnType<typeof createScratch>> | undefined;
  try {
    const outcome = await createScratch(root).then(
      (value) => ({ scratch: value }),
      (failure: unknown) => ({ failure }),
    );
    scratch = "scratch" in outcome ? outcome.scratch : undefined;
    const failure = "failure" in outcome ? outcome.failure : undefined;
    expect(nativeFailure).toBeInstanceOf(Error);
    expect(failure).toBe(nativeFailure);
    expect(scratch).toBeUndefined();
    await expect(fs.readdir(root)).resolves.toEqual([]);
  } finally {
    if (scratch) {
      await expect(finishScratch(scratch, () => {})).resolves.toBeUndefined();
    }
  }
});

it.each([
  { boundary: "payload", removed: "directory" },
  { boundary: "payload", removed: "payload" },
  { boundary: "token", removed: "directory" },
  { boundary: "token", removed: "token" },
] as const)(
  "reports vanished $removed at the $boundary boundary",
  async ({ boundary, removed }) => {
    const root = dirs.make("backup-scratch-vanished-");
    const scratch = boundary === "token" ? await createScratch(root) : undefined;
    const directory = scratch?.directory ?? path.join(root, "openclaw-backup-retired-Gone01");
    const open = vi.fn(sqlite.openNodeSqliteDatabase);
    let observedRemoval = false;
    if (scratch) {
      scratch.release(true);
      const tokenPath = path.join(directory, tokens.SQLITE_STAGING_TOKEN_FILES[0]);
      const tokenLocation = sqlite.resolveExistingSqliteFileUri(tokenPath);
      vi.spyOn(sqlite, "openNodeSqliteDatabase").mockImplementation((...args) => {
        if (args[0] === tokenLocation) {
          observedRemoval = true;
          fsSync.rmSync(removed === "directory" ? directory : tokenPath, { recursive: true });
        }
        return open(...args);
      });
    } else if (removed === "directory") {
      await fs.mkdir(directory);
      const rmdir = fs.rmdir;
      vi.spyOn(fs, "rmdir").mockImplementation(async (...args) => {
        if (args[0] === directory && !observedRemoval) {
          observedRemoval = true;
          await fs.rm(directory, { recursive: true });
        }
        return rmdir(...args);
      });
    } else {
      await fs.mkdir(directory);
      const payload = path.join(directory, "config-0");
      await fs.writeFile(payload, "synthetic config");
      const lstat = fs.lstat;
      vi.spyOn(fs, "lstat").mockImplementation(async (...args) => {
        if (args[0] === payload) {
          observedRemoval = true;
          await fs.rm(payload, { force: true });
        }
        return lstat(...args);
      });
    }
    const log = vi.fn();
    const report = await inspect(root, true, log);
    expect(observedRemoval).toBe(true);
    if (boundary === "token") {
      expect(open.mock.results.find((result) => result.type === "throw")?.value).toBeInstanceOf(
        Error,
      );
      expect(report.active).toEqual([]);
    }
    expect(report).toMatchObject({
      reclaimed: [],
      alreadyReclaimed: removed === "directory" ? [directory] : [],
      warnings:
        removed === "directory"
          ? []
          : [
              expect.stringContaining(
                boundary === "token" ? `Backup scratch preserved at ${directory}:` : directory,
              ),
            ],
    });
    if (removed === "directory") {
      expect(log).toHaveBeenCalledWith(`Backup scratch already reclaimed: ${directory}`);
    } else {
      await expect(fs.stat(directory)).resolves.toBeDefined();
    }
  },
);

it("preserves a symlink target when scratch is replaced after transaction retirement", async () => {
  const parent = dirs.make("backup-scratch-replaced-");
  const scratch = await createScratch(parent);
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
        fsSync.symlinkSync(outside, scratch.directory, linkType);
      }
    },
    {
      beginRetirement: () => {
        release.beginRetirement();
        return scratch.release;
      },
    },
  );
  await expect(finishScratch(scratch, () => {})).resolves.toContain(scratch.directory);
  await expectContents(protectedFile, "unrelated data");
});

it("preserves retired scratch for maintenance instead of admitting it", async () => {
  const root = dirs.make("backup-scratch-admission-");
  const acquire = tokens.acquireSqliteStagingToken;
  let retired: string | undefined;
  vi.spyOn(tokens, "acquireSqliteStagingToken").mockImplementation((directory, mode, options) => {
    if (mode === "create" && !retired) {
      retired = directory;
      acquire(directory, "create")(true);
    }
    return acquire(directory, mode, options);
  });
  await expect(createScratch(root)).rejects.toBeInstanceOf(tokens.SqliteStagingRetiredError);
  const report = await maintainBackupScratch({ roots: [root], repair: true });
  expect(report.reclaimed).toEqual([retired]);
  expect(report.active).toEqual([]);
});

it("preserves unexpected contents and symbolic links instead of adopting them as scratch", async () => {
  const root = dirs.make("backup-scratch-unknown-");
  const unknown = await createScratch(root);
  unknown.release();
  const archive = path.join(unknown.directory, "backup.tar.gz");
  await fs.writeFile(archive, "published backup");
  const linked = path.join(root, "openclaw-backup-linked");
  await fs.symlink(unknown.directory, linked, linkType);
  const report = await inspect(root);
  expect(report.reclaimed).toEqual([]);
  expect(report.warnings).toHaveLength(2);
  expect(report.warnings).toEqual(
    expect.arrayContaining([expect.stringContaining(archive), expect.stringContaining(linked)]),
  );
  await expectContents(archive, "published backup");
  await expect(fs.lstat(linked)).resolves.toSatisfy((entry) => entry.isSymbolicLink());
});

it.each(["admitted", "creating"] as const)(
  "classifies active scratch before inspecting a journal that can disappear (%s)",
  async (phase) => {
    const root = dirs.make("backup-scratch-active-journal-");
    const { entered, resume } =
      phase === "creating"
        ? pauseCreation(root)
        : { entered: createDeferredCore<string>(), resume: createDeferredCore() };
    const creating = createScratch(root);
    const directory = phase === "creating" ? await entered.promise : (await creating).directory;
    const snapshot = path.join(directory, ".sqlite-snapshot-Active");
    const journal = path.join(snapshot, "database.sqlite-journal");
    let database: ReturnType<typeof sqlite.openNodeSqliteDatabase> | undefined;
    const startSnapshot = () => {
      fsSync.mkdirSync(snapshot);
      const opened = sqlite.openNodeSqliteDatabase(path.join(snapshot, "database.sqlite"));
      database = opened;
      opened.exec(
        "PRAGMA journal_mode = DELETE; CREATE TABLE fixture (id INTEGER); BEGIN IMMEDIATE; INSERT INTO fixture VALUES (1);",
      );
      expect(fsSync.existsSync(journal)).toBe(true);
    };
    const lstat = fs.lstat;
    let inspectedJournal = false;
    let observedMissingToken = false;
    const stat = vi.spyOn(fs, "lstat").mockImplementation(async (...args) => {
      if (
        phase === "creating" &&
        args[0] === path.join(directory, tokens.SQLITE_STAGING_TOKEN_FILES[0]) &&
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
      const report = await inspect(root, true, () => {});
      expect(observedMissingToken).toBe(phase === "creating");
      expect(report).toMatchObject({
        warnings: [],
        active: [directory],
        reclaimed: [],
        alreadyReclaimed: [],
      });
      expect(inspectedJournal).toBe(false);
      expect(database?.isTransaction).toBe(true);
    } finally {
      stat.mockRestore();
      resume.resolve();
      if (database?.isTransaction) {
        database.exec("ROLLBACK");
      }
      database?.close();
      await finishScratch(await creating);
    }
  },
);

it("reclaims abandoned archives while a live transaction protects its files", async () => {
  const payloadName = "archive.tar.gz";
  const root = dirs.make("backup-scratch-lifetime-");
  const abandoned = await createScratch(root);
  const active = await createScratch(root);
  const legacy = path.join(root, "openclaw-backup-Legacy");
  const rollback = path.join(root, ".openclaw.package-backup-123-456");
  for (const directory of [abandoned.directory, active.directory, legacy, rollback]) {
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, payloadName), "synthetic backup input");
  }
  abandoned.release();
  try {
    const inspection = await inspect(root, false);
    expect(inspection.reclaimed).toEqual([]);
    expect(inspection.unchecked).toEqual(
      expect.arrayContaining([active.directory, abandoned.directory]),
    );
    await expectContents(path.join(abandoned.directory, payloadName), "synthetic backup input");

    const repair = await inspect(root);
    expect(repair.reclaimed).toEqual([abandoned.directory]);
    expect(repair.active).toEqual([active.directory]);
    expect(repair.warnings).toEqual([expect.stringContaining(legacy)]);
    await expect(fs.stat(abandoned.directory)).rejects.toMatchObject({ code: "ENOENT" });
    for (const directory of [active.directory, legacy, rollback]) {
      await expectContents(path.join(directory, payloadName), "synthetic backup input");
    }
  } finally {
    await finishScratch(active);
  }
});

it("retries retirement after failed payload cleanup", async () => {
  const root = dirs.make("backup-scratch-retry-");
  const scratch = await createScratch(root);
  const payload = path.join(scratch.directory, "config-0");
  await fs.writeFile(payload, "synthetic config");
  const remove = fs.unlink.bind(fs);
  const failure = vi.spyOn(fs, "unlink").mockImplementation(async (target) => {
    if (path.basename(String(target)) === "config-0") {
      throw Object.assign(new Error("cleanup denied"), { code: "EACCES" });
    }
    return remove(target);
  });
  let remaining = scratch.directory;
  try {
    const log = vi.fn();
    const warning = await finishScratch(scratch, log);
    const [retired] = await fs.readdir(root);
    remaining = path.join(root, retired!);
    expect(warning).toContain(remaining);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("cleanup denied"));
    await expect(fs.stat(path.join(remaining, "owner.sqlite"))).resolves.toBeDefined();
  } finally {
    failure.mockRestore();
  }
  const report = await inspect(root);
  expect(report.reclaimed).toEqual([remaining]);
  await expect(fs.stat(remaining)).rejects.toMatchObject({ code: "ENOENT" });
});
