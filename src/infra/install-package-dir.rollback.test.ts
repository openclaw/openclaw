import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { root as fsSafeRoot, type Root } from "@openclaw/fs-safe/root";
import { __setFsSafeTestHooksForTest } from "@openclaw/fs-safe/test-hooks";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { withPluginLifecycleLease } from "../plugins/plugin-lifecycle-lease.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { createSuiteTempRootTracker } from "../test-helpers/temp-dir.js";
import {
  installPackageDir,
  requestDeferredPackageDirInstall,
  resolvePackageDirInstallTransaction,
} from "./install-package-dir.js";
import {
  createExistingInstallFixture,
  listMatchingDirs,
  normalizeComparablePath,
  updateOptions,
} from "./install-package-dir.test-support.js";

async function expectText(directory: string, expected: string, name = "marker.txt") {
  await expect(fs.readFile(path.join(directory, name), "utf8")).resolves.toBe(expected);
}

async function expectIdentity(directory: string, identity: { dev: bigint; ino: bigint }) {
  await expect(fs.lstat(directory, { bigint: true })).resolves.toMatchObject({
    dev: identity.dev,
    ino: identity.ino,
  });
}

async function expectPackage(directory: string, text: string, identity?: fsSync.BigIntStats) {
  await expectText(directory, text);
  if (identity) {
    await expectIdentity(directory, identity);
  }
}

const samePath = (left: fsSync.PathLike, right: fsSync.PathLike) =>
  normalizeComparablePath(String(left)) === normalizeComparablePath(String(right));
const expectMissing = (file: string) =>
  expect(fs.lstat(file)).rejects.toHaveProperty("code", "ENOENT");
const writeText = (directory: string, text: string, name = "marker.txt") =>
  fs.writeFile(path.join(directory, name), text);
const backupHook = (remember: (directory: string) => void) => async (directory: string) => {
  remember(directory);
  return { ok: true as const };
};

function afterRename(effect: (from: fsSync.PathLike, to: fsSync.PathLike) => void | Promise<void>) {
  const rename = fs.rename.bind(fs);
  return vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
    await rename(from, to);
    return effect(from, to);
  });
}

function beforeRemove(effect: (target: string) => void | Promise<void>) {
  __setFsSafeTestHooksForTest({
    beforeRootFallbackMutation: (operation, target) => {
      if (operation === "remove") {
        return effect(target);
      }
    },
  });
}

function failUnlinkOnce(shouldFail: (file: fsSync.PathLike) => boolean, error: Error) {
  let injected = false;
  const unlink = fs.unlink.bind(fs);
  vi.spyOn(fs, "unlink").mockImplementation(async (file) => {
    if (!injected && shouldFail(file)) {
      injected = true;
      throw error;
    }
    await unlink(file);
  });
  return () => injected;
}

async function replaceDirectory(directory: string, retained: string, text: string) {
  await fs.rename(directory, retained);
  await fs.mkdir(directory);
  await writeText(directory, text);
}

describe("installPackageDir rollback", () => {
  const fixtureRootTracker = createSuiteTempRootTracker({
    prefix: "openclaw-install-package-dir-rollback-",
  });

  afterEach(async () => {
    __setFsSafeTestHooksForTest(undefined);
    vi.restoreAllMocks();
    await fixtureRootTracker.cleanup();
  });

  async function createFixture(name: string) {
    await fixtureRootTracker.setup();
    const fixtureRoot = await fixtureRootTracker.make(name);
    const paths = await createExistingInstallFixture(fixtureRoot);
    const install = (
      options: Partial<Parameters<typeof installPackageDir>[0]> = {},
      assertOwned?: () => void,
    ) =>
      installPackageDir(
        requestDeferredPackageDirInstall(
          { ...updateOptions(paths.sourceDir, paths.targetDir), ...options },
          assertOwned,
        ),
      );
    return {
      fixtureRoot,
      leaseOptions: { path: path.join(fixtureRoot, "leases.sqlite"), leaseMs: 300_000, waitMs: 0 },
      ...paths,
      install,
      async retain(
        this: void,
        options: Pick<Parameters<typeof installPackageDir>[0], "sourceHardlinks"> = {},
        assertOwned?: () => void,
      ) {
        let backupDir = "";
        const result = await install(
          {
            ...options,
            afterBackup: backupHook((directory) => {
              backupDir = directory;
            }),
          },
          assertOwned,
        );
        expect(result.ok).toBe(true);
        const transaction = resolvePackageDirInstallTransaction(result);
        if (!transaction) {
          throw new Error("Expected a retained package transaction");
        }
        return { backupDir, transaction };
      },
    };
  }

  it.each(["commit", "rollback"] as const)(
    "rejects %s under a successor lease after the original install owner retires",
    async (action) => {
      const { leaseOptions, retain, targetDir } = await createFixture(
        `retired-settlement-${action}`,
      );
      const original = await withPluginLifecycleLease(leaseOptions, async (lease) => ({
        ...(await retain({}, lease.assertOwned.bind(lease))),
        assertOwned: lease.assertOwned.bind(lease),
      }));
      expect(original.assertOwned).toThrow();
      const installedIdentity = await fs.lstat(targetDir, { bigint: true });
      const backupIdentity = await fs.lstat(original.backupDir, { bigint: true });

      await withPluginLifecycleLease(leaseOptions, async (lease) => {
        await expect(original.transaction[action](lease.assertOwned.bind(lease))).rejects.toThrow();
        lease.assertOwned();
        await expectPackage(targetDir, "new", installedIdentity);
        await expectPackage(original.backupDir, "old", backupIdentity);
      });
    },
  );

  it("reports incomplete recovery when a deferred backup cannot be restored", async () => {
    const { install, targetDir } = await createFixture("deferred-restore-blocked");
    const result = await install({
      afterBackup: async () => {
        await fs.mkdir(targetDir, { recursive: true });
        await writeText(targetDir, "successor", "successor.txt");
        return { ok: false as const, error: "backup rejected" };
      },
    });

    expect(result).toMatchObject({
      ok: false,
      recoveryIncomplete: true,
      error: expect.stringContaining("backup retained"),
    });
    await expectText(targetDir, "successor", "successor.txt");
  });

  it("preserves the Windows EPERM backup copy fallback", async () => {
    const { sourceDir, targetDir } = await createFixture("windows-backup-eperm");
    let denied = false;
    const denyInitialBackupRename = (from: fsSync.PathLike, to: fsSync.PathLike) => {
      if (
        !denied &&
        samePath(from, targetDir) &&
        path.basename(path.dirname(String(to))) === ".openclaw-install-backups"
      ) {
        denied = true;
        throw Object.assign(new Error("Windows sharing violation"), { code: "EPERM" });
      }
    };
    const realRename = fs.rename.bind(fs);
    const realRenameSync = fsSync.renameSync.bind(fsSync);
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    vi.spyOn(fs, "rename").mockImplementation((from, to) => {
      denyInitialBackupRename(from, to);
      return realRename(from, to);
    });
    vi.spyOn(fsSync, "renameSync").mockImplementation((from, to) => {
      denyInitialBackupRename(from, to);
      return realRenameSync(from, to);
    });
    const result = await installPackageDir({
      ...updateOptions(sourceDir, targetDir),
      sourceHardlinks: "package-manager",
    });
    expect(denied).toBe(true);
    expect(result.ok).toBe(true);
    await expectText(targetDir, "new");
  });

  it("preserves the canonical tree when ownership closes after backup copy publication", async () => {
    const { install, targetDir } = await createFixture("backup-copy-owner");
    const expired = new Error("install owner expired after backup publication");
    let ownerActive = true;
    let revoked = false;
    let treeAtRevocation: Record<string, string> | undefined;
    const readTargetTree = async () => {
      const entries = await fs.readdir(targetDir, { recursive: true, withFileTypes: true });
      return Object.fromEntries(
        await Promise.all(
          entries
            .filter((entry) => entry.isFile())
            .map(async (entry) => {
              const file = path.join(entry.parentPath, entry.name);
              return [path.relative(targetDir, file), await fs.readFile(file, "utf8")];
            }),
        ),
      );
    };
    afterRename(async (from, to) => {
      if (
        !revoked &&
        path.basename(String(from)).startsWith(".fs-safe-move-") &&
        path.basename(path.dirname(String(to))) === ".openclaw-install-backups"
      ) {
        await fs.mkdir(targetDir, { recursive: true });
        await writeText(targetDir, "successor-owned", "successor.txt");
        treeAtRevocation = await readTargetTree();
        ownerActive = false;
        revoked = true;
      }
    });

    const result = await install({}, () => {
      if (!ownerActive) {
        throw expired;
      }
    });

    expect(revoked).toBe(true);
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining(expired.message) });
    expect(await readTargetTree()).toEqual(treeAtRevocation);
  });

  it("preserves a successor when an earlier update rollback finishes delayed removal", async () => {
    const { leaseOptions, sourceDir, targetDir, retain } =
      await createFixture("rollback-removal-owner");
    const installOptions = updateOptions(sourceDir, targetDir);
    const paused = createDeferred();
    const release = createDeferred();
    let originalBackup = "";
    let rollback = Promise.resolve();

    const original = withPluginLifecycleLease(leaseOptions, async (lease) => {
      const assertOwned = lease.assertOwned.bind(lease);
      const { backupDir, transaction } = await retain({}, assertOwned);
      originalBackup = backupDir;
      const publishedIdentity = await fs.lstat(targetDir, { bigint: true });
      let pauseConsumed = false;
      beforeRemove(async (target) => {
        const candidate = fsSync.lstatSync(path.dirname(target), {
          bigint: true,
          throwIfNoEntry: false,
        });
        if (
          !pauseConsumed &&
          candidate?.dev === publishedIdentity.dev &&
          candidate.ino === publishedIdentity.ino
        ) {
          pauseConsumed = true;
          paused.resolve();
          await release.promise;
        }
      });
      rollback = transaction.rollback();
      void rollback.catch(() => undefined);
      await Promise.race([
        paused.promise,
        rollback.then(() => {
          throw new Error("rollback completed before recursive removal paused");
        }),
      ]);
      // A retained operation can outlive its lease; B must never inherit A's cleanup.
      return { assertOwned };
    });
    try {
      const closed = await original;
      expect(closed.assertOwned).toThrow();
      await writeText(sourceDir, "successor");
      await withPluginLifecycleLease(leaseOptions, async (lease) => {
        const successor = await installPackageDir({
          ...installOptions,
          mode: "update",
          beforePersistentApply: lease.assertOwned.bind(lease),
        });
        expect(successor.ok).toBe(true);
        const successorIdentity = await fs.lstat(targetDir, { bigint: true });
        release.resolve();
        await rollback.catch(() => undefined);
        lease.assertOwned();
        await expectPackage(targetDir, "successor", successorIdentity);
        await expectText(originalBackup, "old");
      });
    } finally {
      release.resolve();
      await original.catch(() => undefined);
      await rollback.catch(() => undefined);
      closeOpenClawStateDatabaseForTest();
    }
  });

  it.each(["removal", "restoration"] as const)(
    "retains rollback progress for a retry after %s fails",
    async (failure) => {
      const { installBaseDir, targetDir, retain } = await createFixture("rollback-retry");
      const { backupDir, transaction } = await retain();
      const publishedIdentity = await fs.lstat(targetDir, { bigint: true });
      const ioError = Object.assign(new Error(`${failure} failed`), { code: "EIO" });
      let injected = false;
      const realRename = fs.rename.bind(fs);
      if (failure === "removal") {
        const prototype = Object.getPrototypeOf(await fsSafeRoot(installBaseDir)) as Root;
        // oxlint-disable-next-line typescript/unbound-method -- Called below with the intercepted Root receiver to preserve its path and mutation authority.
        const remove = prototype.remove;
        vi.spyOn(prototype, "remove").mockImplementation(async function (
          this: Root,
          target,
          options,
        ) {
          const current = fsSync.lstatSync(path.dirname(path.join(this.rootReal, target)), {
            bigint: true,
            throwIfNoEntry: false,
          });
          if (
            !injected &&
            current?.dev === publishedIdentity.dev &&
            current.ino === publishedIdentity.ino
          ) {
            injected = true;
            throw ioError;
          }
          await remove.call(this, target, options);
        });
      } else {
        vi.spyOn(fs, "rename").mockImplementation((...args: Parameters<typeof fs.rename>) => {
          if (!injected && samePath(args[1], targetDir)) {
            injected = true;
            return Promise.reject(ioError);
          }
          return realRename(...args);
        });
      }

      const rollback = transaction.rollback();
      if (failure === "restoration") {
        await expect(rollback).rejects.toMatchObject({
          cause: ioError,
          message: expect.stringContaining(backupDir),
        });
      } else {
        await expect(rollback).rejects.toBe(ioError);
      }
      expect(injected).toBe(true);
      await expectText(backupDir, "old");
      await transaction.rollback();
      await expectText(targetDir, "old");
      expect(await fs.readdir(path.dirname(backupDir))).toEqual([]);
      expect(await listMatchingDirs(installBaseDir, ".openclaw-install-rollback-")).toEqual([]);
    },
  );

  it.each([
    {
      name: "immediate errno",
      retained: false,
      refusal: Object.assign(new Error("original retirement owner refused"), { code: "EIO" }),
    },
    { name: "retained false", retained: true, refusal: false },
    {
      name: "retained errno",
      retained: true,
      refusal: Object.assign(new Error("retained owner missing"), { code: "ENOENT" }),
    },
    { name: "retained Promise", retained: true, refusal: undefined },
  ])("stops backup retirement on a one-shot $name refusal", async ({ refusal, retained }) => {
    const { retain, sourceDir, targetDir } = await createFixture("settlement-refusal");
    await writeText(targetDir, "first", "a.txt");
    await writeText(targetDir, "retained", "b.txt");
    let armed = false;
    let refusals = 0;
    const assertOwned = (): unknown => {
      if (armed && refusals === 0) {
        refusals += 1;
        if (refusal === undefined) {
          return Promise.resolve();
        }
        // oxlint-disable-next-line typescript/only-throw-error -- Non-Error owner refusals must retain their exact identity.
        throw refusal;
      }
      return undefined;
    };
    let backupDir = "";
    let liveIdentity: fsSync.BigIntStats | undefined;
    const transaction = retained
      ? await retain({}, assertOwned).then((result) => {
          backupDir = result.backupDir;
          return result.transaction;
        })
      : undefined;
    if (transaction) {
      liveIdentity = await fs.lstat(targetDir, { bigint: true });
    } else {
      afterRename(async (_from, to) => {
        if (samePath(to, targetDir)) {
          liveIdentity = await fs.lstat(targetDir, { bigint: true });
        }
      });
    }
    let injections = 0;
    beforeRemove((target) => {
      if (liveIdentity && samePath(target, path.join(backupDir, "b.txt"))) {
        injections += 1;
        armed = true;
      }
    });
    const unlink = transaction && vi.spyOn(fs, "unlink");
    const rmdir = transaction && vi.spyOn(fs, "rmdir");
    const rename = transaction && vi.spyOn(fs, "rename");
    const renameSync = transaction && vi.spyOn(fsSync, "renameSync");

    const retirement = transaction
      ? transaction.commit()
      : installPackageDir({
          ...updateOptions(sourceDir, targetDir),
          beforePersistentApply: assertOwned,
          afterBackup: backupHook((directory) => {
            backupDir = directory;
          }),
        });
    const firstRefusal = await retirement.then(
      () => undefined,
      (error: unknown) => error,
    );
    if (refusal === undefined) {
      expect(firstRefusal).toBeInstanceOf(TypeError);
    } else {
      expect(firstRefusal).toBe(refusal);
    }
    expect(injections).toBe(1);
    expect(refusals).toBe(1);
    await expectMissing(path.join(backupDir, "a.txt"));
    if (transaction) {
      expect(unlink).toHaveBeenCalledOnce();
      for (const action of ["commit", "rollback", "commit", "rollback"] as const) {
        await expect(transaction[action]()).rejects.toBe(firstRefusal);
      }
      expect(injections).toBe(1);
      expect(refusals).toBe(1);
      expect(unlink).toHaveBeenCalledOnce();
      expect(rmdir).not.toHaveBeenCalled();
      expect(rename).not.toHaveBeenCalled();
      expect(renameSync).not.toHaveBeenCalled();
      await expectText(backupDir, "old");
    }
    if (!liveIdentity) {
      throw new Error("expected a published package identity");
    }
    await expectPackage(targetDir, "new", liveIdentity);
    await expectText(backupDir, "retained", "b.txt");
  });

  it("does not clean a replacement quarantine or restore over it after private custody changes", async () => {
    const { fixtureRoot, retain, targetDir } = await createFixture("rollback-private-owner");
    const retained = path.join(fixtureRoot, "retained-quarantine");
    const { backupDir, transaction } = await retain();
    let replaced = "";
    beforeRemove(async (target) => {
      const quarantine = path.dirname(path.dirname(target));
      if (!replaced && path.basename(quarantine).startsWith(".openclaw-install-rollback-")) {
        replaced = quarantine;
        await fs.rename(quarantine, retained);
        await fs.mkdir(path.join(quarantine, "package"), { recursive: true });
        await writeText(path.join(quarantine, "package"), "foreign");
      }
    });

    await expect(transaction.rollback()).rejects.toThrow("install directory changed");

    expect(replaced).not.toBe("");
    await expectText(path.join(replaced, "package"), "foreign");
    await expectText(path.join(retained, "package"), "new");
    await expectText(backupDir, "old");
    await expectMissing(targetDir);
  });

  it.each([
    { replaced: "backup", action: "commit", sourceHardlinks: "package-manager" },
    { replaced: "backup", action: "rollback", sourceHardlinks: "reject" },
    { replaced: "install", action: "rollback", sourceHardlinks: "reject" },
  ] as const)(
    "preserves a substituted $sourceHardlinks $replaced when $action is requested",
    async ({ replaced, action, sourceHardlinks }) => {
      const { fixtureRoot, leaseOptions, retain, targetDir } =
        await createFixture("substituted-identity");
      const run = async (assertOwned?: () => void) => {
        const { backupDir, transaction } = await retain({ sourceHardlinks }, assertOwned);
        const substitutedDir = replaced === "backup" ? backupDir : targetDir;
        const retainedDir = path.join(fixtureRoot, "retained-original");
        const replacement = replaced === "backup" ? "foreign backup" : "replacement";
        await replaceDirectory(substitutedDir, retainedDir, replacement);
        const replacementIdentity =
          replaced === "install" ? await fs.lstat(targetDir, { bigint: true }) : undefined;
        assertOwned?.();

        await expect(transaction[action]()).rejects.toThrow("install directory changed");
        await expectText(substitutedDir, replacement);
        await expectText(retainedDir, replaced === "backup" ? "old" : "new");
        await expectText(
          replaced === "backup" ? targetDir : backupDir,
          replaced === "backup" ? "new" : "old",
        );

        if (replacementIdentity) {
          await expectIdentity(targetDir, replacementIdentity);
        } else {
          await fs.rm(backupDir, { recursive: true });
          await fs.rename(retainedDir, backupDir);
          await transaction[action]();
          await expectText(targetDir, action === "commit" ? "new" : "old");
        }
      };
      if (replaced === "backup") {
        await run();
      } else {
        try {
          await withPluginLifecycleLease(leaseOptions, async (lease) =>
            run(lease.assertOwned.bind(lease)),
          );
        } finally {
          closeOpenClawStateDatabaseForTest();
        }
      }
    },
  );

  it("preserves the published tree when Windows reports an unknown inode during rollback", async () => {
    const { retain, targetDir } = await createFixture("rollback-unknown-identity");
    const { backupDir, transaction } = await retain({
      sourceHardlinks: "package-manager",
    });
    const realLstat = fsSync.lstatSync.bind(fsSync);
    const platform = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const lstat = vi.spyOn(fsSync, "lstatSync").mockImplementation((candidate, options) => {
      const current = realLstat(candidate, options);
      if (samePath(candidate, targetDir) && current && typeof current.dev === "bigint") {
        Object.defineProperty(current, "ino", { value: 0n });
      }
      return current;
    });
    try {
      await expect(transaction.rollback()).rejects.toThrow("install directory changed");
    } finally {
      lstat.mockRestore();
      platform.mockRestore();
    }
    await expectText(targetDir, "new");
    await expectText(backupDir, "old");
    await transaction.rollback();
    await expectText(targetDir, "old");
  });

  it.each([
    { mode: "install", failure: "source cleanup" },
    { mode: "update", failure: "caller revocation" },
  ] as const)(
    "reverses an $mode publication when $failure fails with the lifecycle owner still active",
    async ({ mode, failure }) => {
      const { install, sourceDir, targetDir } = await createFixture("owned-publication-failure");
      if (mode === "install") {
        await fs.rm(targetDir, { recursive: true });
      }
      let stageDir = "";
      let published = false;
      let callerActive = true;
      const sourceCleanupError = Object.assign(new Error("published source cleanup failed"), {
        code: "EIO",
      });
      const callerError = new Error("initiating caller closed after publication");
      afterRename((_from, to) => {
        if (!published && samePath(to, targetDir)) {
          published = true;
          if (failure === "caller revocation") {
            callerActive = false;
          }
        }
      });
      const cleanupFailed = failUnlinkOnce(
        (file) =>
          failure === "source cleanup" &&
          published &&
          samePath(file, path.join(stageDir, "marker.txt")),
        sourceCleanupError,
      );

      const result = await install(
        {
          mode,
          sourceHardlinks: "reject",
          afterCopy: (directory: string) => {
            stageDir = directory;
          },
          beforePersistentApply: () => {
            if (!callerActive) {
              throw callerError;
            }
          },
        },
        // Caller cancellation must not revoke the transaction owner's rollback authority.
        () => {},
      );

      expect(published).toBe(true);
      expect(failure === "caller revocation" ? !callerActive : cleanupFailed()).toBe(true);
      expect(result).toMatchObject({
        ok: false,
        error: expect.stringContaining(
          failure === "source cleanup" ? sourceCleanupError.message : callerError.message,
        ),
      });
      if (mode === "update") {
        await expectText(targetDir, "old");
      } else {
        await expectMissing(targetDir);
      }
      await expectText(sourceDir, "new");
    },
  );

  it("awaits planning hooks and restores the original after a publication assertion returns a Promise", async () => {
    const { install, sourceDir, targetDir } = await createFixture("async-publication-assertion");
    const original = await fs.lstat(targetDir, { bigint: true });
    const phases: string[] = [];
    let backupDir = "";
    let armed = false;
    let refusals = 0;
    const rename = vi.spyOn(fs, "rename");
    const result = await install(
      {
        sourceHardlinks: "package-manager",
        afterCopy: async (directory: string) => {
          await expectText(directory, "new");
          phases.push("copied");
        },
        afterInstall: async (directory: string) => {
          await expectText(directory, "new");
          phases.push("installed");
          return { ok: true as const };
        },
        afterBackup: async (directory: string) => {
          backupDir = directory;
          await expectText(directory, "old");
          phases.push("backed up");
          armed = true;
          return { ok: true as const };
        },
        beforePersistentApply(): unknown {
          if (armed) {
            refusals += 1;
            return Promise.resolve();
          }
          return undefined;
        },
      },
      // Publication-only refusal leaves the original transaction owner authorized to restore.
      () => {},
    );

    expect(phases).toEqual(["copied", "installed", "backed up"]);
    expect(result).toEqual({
      ok: false,
      error: "failed to copy plugin: TypeError: mutation authority must be synchronous",
    });
    expect(refusals).toBe(1);
    expect(
      rename.mock.calls.map((pair) => pair.map((p) => normalizeComparablePath(String(p)))),
    ).toEqual(
      [
        [targetDir, backupDir],
        [backupDir, targetDir],
      ].map((pair) => pair.map(normalizeComparablePath)),
    );
    await expectPackage(targetDir, "old", original);
    await expectText(sourceDir, "new");
    await expectMissing(backupDir);
  });

  it.each(["unchanged", "replaced", "replaced-during-cleanup", "backup removed"] as const)(
    "retries backup cleanup after restoration publication (%s)",
    async (retryState) => {
      const { fixtureRoot, retain, targetDir } = await createFixture("restoration-cleanup-retry");
      await writeText(targetDir, '{"original":true}\n', "settings.json");
      const { backupDir, transaction } = await retain({
        sourceHardlinks: "reject",
      });
      let restored = false;
      const cleanupError = Object.assign(new Error("restored backup cleanup failed"), {
        code: "EIO",
      });
      afterRename((_from, to) => {
        if (samePath(to, targetDir)) {
          restored = true;
        }
      });
      const cleanupFailed = failUnlinkOnce(
        (file) => restored && samePath(path.dirname(String(file)), backupDir),
        cleanupError,
      );

      const rollbackError = await transaction.rollback().then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(restored).toBe(true);
      expect(cleanupFailed()).toBe(true);
      for (const detail of [cleanupError.message, "published", targetDir, backupDir]) {
        expect(String(rollbackError)).toContain(detail);
      }
      // The dependency's initial cleanup need not visit backup files in lexical order.
      for (const directory of [targetDir, backupDir]) {
        await expectText(directory, "old");
        await expectText(directory, '{"original":true}\n', "settings.json");
      }

      const replaceTarget = () =>
        replaceDirectory(targetDir, path.join(fixtureRoot, "retained-original"), "successor");
      if (retryState === "replaced") {
        await replaceTarget();
      } else if (retryState === "backup removed") {
        await fs.rm(backupDir, { recursive: true });
      }
      let targetIdentity = await fs.lstat(targetDir, { bigint: true });
      let replacedDuringCleanup = false;
      if (retryState === "replaced-during-cleanup") {
        beforeRemove(async (target) => {
          if (!replacedDuringCleanup && samePath(target, path.join(backupDir, "settings.json"))) {
            replacedDuringCleanup = true;
            await replaceTarget();
            targetIdentity = await fs.lstat(targetDir, { bigint: true });
          }
        });
      }
      if (retryState === "unchanged" || retryState === "backup removed") {
        await transaction.rollback();
        await expectMissing(backupDir);
        await expectText(targetDir, '{"original":true}\n', "settings.json");
      } else {
        await expect(transaction.rollback()).rejects.toThrow();
        if (retryState === "replaced-during-cleanup") {
          expect(replacedDuringCleanup).toBe(true);
          await expectText(backupDir, '{"original":true}\n', "settings.json");
          await expectMissing(path.join(backupDir, "marker.txt"));
        } else {
          await expectText(backupDir, "old");
        }
      }
      await expectPackage(
        targetDir,
        retryState === "replaced" || retryState === "replaced-during-cleanup" ? "successor" : "old",
        targetIdentity,
      );
    },
  );

  it("retains and reports an update publication after the original lifecycle lease closes", async () => {
    const { leaseOptions, install, targetDir } = await createFixture("revoked-publication-owner");
    const reachedPublication = createDeferred();
    const resumeCleanup = createDeferred();
    let published = false;
    let backupDir = "";
    let pendingInstall: ReturnType<typeof installPackageDir> | undefined;
    afterRename(async (_from, to) => {
      if (!published && samePath(to, targetDir)) {
        published = true;
        reachedPublication.resolve();
        await resumeCleanup.promise;
      }
    });

    const lifecycle = withPluginLifecycleLease(leaseOptions, async (lease) => {
      const assertOwned = lease.assertOwned.bind(lease);
      pendingInstall = install(
        {
          sourceHardlinks: "reject",
          afterBackup: backupHook((directory) => {
            backupDir = directory;
          }),
        },
        assertOwned,
      );
      await Promise.race([
        reachedPublication.promise,
        pendingInstall.then(() => {
          throw new Error("install finished before publication paused");
        }),
      ]);
      return assertOwned;
    });

    try {
      const assertClosedOwner = await lifecycle;
      expect(assertClosedOwner).toThrow();
      const publishedIdentity = await fs.lstat(targetDir, { bigint: true });
      resumeCleanup.resolve();
      if (!pendingInstall) {
        throw new Error("expected an in-flight install");
      }
      const result = await pendingInstall;
      expect(published).toBe(true);
      expect(result.ok).toBe(false);
      if (result.ok) {
        throw new Error("expected closed lifecycle ownership to reject source cleanup");
      }
      expect.soft(result.error).toContain("published");
      expect.soft(result.error).toContain(targetDir);
      await expectPackage(targetDir, "new", publishedIdentity);
      expect(backupDir).not.toBe("");
      expect.soft(result.error).toContain(backupDir);
      await expectText(backupDir, "old");
    } finally {
      resumeCleanup.resolve();
      await lifecycle.catch(() => undefined);
      await pendingInstall?.catch(() => undefined);
      closeOpenClawStateDatabaseForTest();
    }
  });
});
