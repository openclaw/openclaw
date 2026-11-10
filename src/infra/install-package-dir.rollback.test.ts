import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { root as fsSafeRoot, type Root } from "@openclaw/fs-safe/root";
import { __setFsSafeTestHooksForTest } from "@openclaw/fs-safe/test-hooks";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../test/helpers/promise.js";
import { withPluginLifecycleLease } from "../plugins/plugin-lifecycle-lease.js";
import { closeOpenClawStateDatabaseByPathAsync } from "../state/openclaw-state-db.js";
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
import * as packageFilesystem from "./package-update-filesystem.js";
import * as retry from "./retry.js";

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
const ioError = (message: string, code = "EIO") => Object.assign(new Error(message), { code });
const backupHook = (remember: (directory: string) => void) => async (directory: string) => {
  remember(directory);
  return { ok: true as const };
};

function recordBackup() {
  const backup = { path: "", afterBackup: backupHook((directory) => (backup.path = directory)) };
  return backup;
}

function expectFailure(
  result: Awaited<ReturnType<typeof installPackageDir>>,
  ...details: string[]
) {
  expect(result.ok).toBe(false);
  if (result.ok) {
    throw new Error("expected install failure");
  }
  for (const detail of details) {
    expect(result.error).toContain(detail);
  }
}

function afterRename(effect: (from: fsSync.PathLike, to: fsSync.PathLike) => void | Promise<void>) {
  const rename = fs.rename.bind(fs);
  return vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
    await rename(from, to);
    return effect(from, to);
  });
}

function afterPublication(targetDir: string, effect: () => void | Promise<void>) {
  let published = false;
  afterRename((_from, to) => {
    if (!published && samePath(to, targetDir)) {
      published = true;
      return effect();
    }
  });
  return () => published;
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

function isInsideIdentity(target: string, identity: fsSync.BigIntStats) {
  const parent = fsSync.lstatSync(path.dirname(target), { bigint: true, throwIfNoEntry: false });
  return parent?.dev === identity.dev && parent.ino === identity.ino;
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

function holdMarker(targetDir: string, onHold: () => Promise<void>, code = "EBUSY") {
  const unlink = fs.unlink.bind(fs);
  vi.spyOn(fs, "unlink").mockImplementation(async (file) => {
    if (samePath(file, path.join(targetDir, "marker.txt"))) {
      await onHold();
      throw ioError("held plugin file", code);
    }
    return unlink(file);
  });
}

async function replaceDirectory(directory: string, retained: string, text: string) {
  await fs.rename(directory, retained);
  await fs.mkdir(directory);
  await writeText(directory, text);
}

describe("installPackageDir rollback", () => {
  const fixtureDatabasePaths = new Set<string>();
  const fixtureRootTracker = createSuiteTempRootTracker({
    prefix: "openclaw-install-package-dir-rollback-",
  });

  afterEach(async () => {
    __setFsSafeTestHooksForTest(undefined);
    vi.restoreAllMocks();
    for (const pathname of fixtureDatabasePaths) {
      await closeOpenClawStateDatabaseByPathAsync(pathname);
    }
    fixtureDatabasePaths.clear();
    await fixtureRootTracker.cleanup();
  });

  it.each(["retry", "I/O failure", "closed owner"] as const)(
    "recovers a partially displaced held install: %s",
    async (failure) => {
      const { sourceDir, targetDir } = await createFixture("held-recovery");
      const nested = path.join(targetDir, "nested");
      await fs.mkdir(nested);
      await writeText(nested, "keep nested", "index.js");
      await writeText(targetDir, "keep config", "openclaw.plugin.json");
      let recovering = false;
      holdMarker(
        targetDir,
        async () => {
          await fs.rm(nested, { recursive: true, force: true });
          await fs.rm(path.join(targetDir, "openclaw.plugin.json"), { force: true });
          recovering = true;
        },
        failure === "retry" ? "EBUSY" : "EPERM",
      );
      if (failure === "I/O failure") {
        const copy = fsSync.cpSync.bind(fsSync);
        vi.spyOn(fsSync, "cpSync").mockImplementation((source, destination, options) => {
          if (recovering) {
            throw ioError("recovery disk full", "ENOSPC");
          }
          return copy(source, destination, options);
        });
      }
      const options = updateOptions(sourceDir, targetDir);
      const result = await installPackageDir(
        failure === "retry"
          ? options
          : requestDeferredPackageDirInstall(options, () => {
              if (recovering && failure === "closed owner") {
                throw new Error("recovery owner closed");
              }
            }),
      );
      const backupRoot = path.join(path.dirname(targetDir), ".openclaw-install-backups");
      const backups = await fs.readdir(backupRoot);
      await expectText(targetDir, "old");
      if (failure === "retry") {
        expectFailure(result, "stop the Gateway and retry");
        expect(result).not.toHaveProperty("recoveryIncomplete");
        expect(backups).toEqual([]);
        await expectText(targetDir, "keep config", "openclaw.plugin.json");
        await expectText(nested, "keep nested", "index.js");
        vi.restoreAllMocks();
        expect(await installPackageDir(options)).toEqual({ ok: true });
        await expectText(targetDir, "new");
      } else {
        expect(backups).toHaveLength(1);
        const backup = path.join(backupRoot, expectDefined(backups[0], "recovery backup"));
        expect(result).toHaveProperty("recoveryIncomplete", true);
        expectFailure(
          result,
          "backup recovery path: " + backup,
          failure === "I/O failure" ? "recovery disk full" : "recovery owner closed",
        );
        await expectText(backup, "old");
        await expectText(backup, "keep config", "openclaw.plugin.json");
        await expectMissing(path.join(targetDir, "openclaw.plugin.json"));
      }
    },
  );

  it.each(["transient", "persistent", "rejected hardlinks"] as const)(
    "retries a Windows plugin backup rename held by a scanner: %s",
    async (scenario) => {
      const [move, runRetry] = [packageFilesystem.movePackageRoot, retry.retryAsync];
      vi.spyOn(packageFilesystem, "movePackageRoot").mockImplementation((from, to, options) =>
        move(from, to, { ...options, platform: "win32" }),
      );
      vi.spyOn(retry, "retryAsync").mockImplementation((fn, options) =>
        runRetry(fn, { ...(typeof options === "object" ? options : {}), sleep: async () => {} }),
      );
      const { sourceDir, targetDir } = await createFixture("windows-held");
      const rename = fs.rename.bind(fs);
      let denied = 0;
      vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
        if (samePath(from, targetDir) && (scenario === "persistent" || denied < 2)) {
          denied++;
          throw ioError("EPERM: plugin file is in use", "EPERM");
        }
        return rename(from, to);
      });
      const warn = vi.fn();
      const result = await installPackageDir({
        ...updateOptions(sourceDir, targetDir),
        logger: { warn },
        // Rejected hardlinks always publish fs-safe's fresh copy instead of renaming.
        sourceHardlinks: scenario === "rejected hardlinks" ? undefined : "package-manager",
      });
      const backups = await fs.readdir(
        path.join(path.dirname(targetDir), ".openclaw-install-backups"),
      );
      expect(backups).toEqual([]);
      if (scenario !== "persistent") {
        expect(result).toEqual({ ok: true });
        await expectText(targetDir, "new");
        expect([warn.mock.calls.length, denied]).toEqual(
          scenario === "transient" ? [2, 2] : [0, 0],
        );
      } else {
        expectFailure(result, "plugin backup rename failed after 16 attempts", "stop the Gateway");
        await expectText(targetDir, "old");
      }
    },
  );

  async function createFixture(name: string) {
    await fixtureRootTracker.setup();
    const fixtureRoot = await fixtureRootTracker.make(name);
    const databasePath = path.join(fixtureRoot, "leases.sqlite");
    fixtureDatabasePaths.add(databasePath);
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
      leaseOptions: {
        path: databasePath,
        env: { ...process.env, OPENCLAW_STATE_DIR: fixtureRoot },
        leaseMs: 300_000,
        waitMs: 0,
      },
      ...paths,
      install,
      async retain(
        this: void,
        options: Pick<Parameters<typeof installPackageDir>[0], "sourceHardlinks"> = {},
        assertOwned?: () => void,
      ) {
        const backup = recordBackup();
        const result = await install({ ...options, afterBackup: backup.afterBackup }, assertOwned);
        expect(result.ok).toBe(true);
        return {
          backupDir: backup.path,
          transaction: expectDefined(
            resolvePackageDirInstallTransaction(result),
            "retained package transaction",
          ),
        };
      },
    };
  }

  it.each(["commit", "rollback", "internal failure"] as const)(
    "awaits original durable authority before %s touches the shared install",
    async (action) => {
      const { sourceDir, targetDir } = await createFixture("awaited-settlement-owner");
      const refusal = new Error("durable install owner replaced");
      let owned = true;
      let published = false;
      let backupDir = "";
      const prepareSettlement = vi.fn(async () => {
        await Promise.resolve();
        if (!owned) {
          throw refusal;
        }
      });
      afterRename((_from, to) => {
        if (samePath(to, targetDir)) {
          published = true;
          if (action === "internal failure") {
            owned = false;
          }
        }
      });
      const result = await installPackageDir(
        requestDeferredPackageDirInstall(
          {
            ...updateOptions(sourceDir, targetDir),
            afterBackup: backupHook((directory) => {
              backupDir = directory;
            }),
            beforePersistentApply: () => {
              if (published && action === "internal failure") {
                throw new Error("publication cancelled");
              }
            },
          },
          () => {},
          prepareSettlement,
        ),
      );
      expect(published).toBe(true);
      const identity = await fs.lstat(targetDir, { bigint: true });
      if (action === "internal failure") {
        expect(result).toMatchObject({
          ok: false,
          recoveryIncomplete: true,
          error: expect.stringContaining(refusal.message),
        });
      } else {
        const transaction = expectDefined(
          resolvePackageDirInstallTransaction(result),
          "deferred transaction",
        );
        owned = false;
        await expect(transaction[action]()).rejects.toBe(refusal);
        owned = true;
        await expect(transaction[action]()).rejects.toBe(refusal);
      }
      expect(prepareSettlement).toHaveBeenCalledOnce();
      await expectPackage(targetDir, "new", identity);
      await expectText(backupDir, "old");
    },
  );

  it.each(["commit", "rollback"] as const)(
    "rejects %s under a successor lease after the original install owner retires",
    async (action) => {
      const { leaseOptions, retain, targetDir } = await createFixture(
        `retired-settlement-${action}`,
      );
      const original = await withPluginLifecycleLease(leaseOptions, async (lease) => ({
        ...(await retain({}, lease.assertOwned)),
        assertOwned: lease.assertOwned,
      }));
      expect(original.assertOwned).toThrow();
      const installedIdentity = await fs.lstat(targetDir, { bigint: true });
      const backupIdentity = await fs.lstat(original.backupDir, { bigint: true });

      await withPluginLifecycleLease(leaseOptions, async (lease) => {
        await expect(original.transaction[action](lease.assertOwned)).rejects.toThrow();
        lease.assertOwned();
        await expectPackage(targetDir, "new", installedIdentity);
        await expectPackage(original.backupDir, "old", backupIdentity);
      });
    },
  );

  it("retains a refused backup instead of restoring over a successor", async () => {
    const { install, targetDir } = await createFixture("deferred-restore-blocked");
    const result = await install({
      afterBackup: async () => {
        await fs.mkdir(targetDir, { recursive: true });
        await writeText(targetDir, "successor", "successor.txt");
        return { ok: false as const, error: "backup rejected" };
      },
    });
    expect(result).toHaveProperty("recoveryIncomplete", true);
    expectFailure(result, "backup retained");
    await expectText(targetDir, "successor", "successor.txt");
    await expectMissing(path.join(targetDir, "marker.txt"));
  });

  it("preserves the canonical tree when ownership closes after backup copy publication", async () => {
    const { install, targetDir } = await createFixture("backup-copy-owner");
    const expired = new Error("install owner expired after backup publication");
    let ownerActive = true;
    let revoked = false;
    afterRename(async (from, to) => {
      if (
        !revoked &&
        path.basename(String(from)).startsWith(".fs-safe-move-") &&
        path.basename(path.dirname(String(to))) === ".openclaw-install-backups"
      ) {
        await fs.mkdir(targetDir, { recursive: true });
        await writeText(targetDir, "successor-owned", "successor.txt");
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
    expectFailure(result, expired.message);
    await expectText(targetDir, "old");
    await expectText(targetDir, "successor-owned", "successor.txt");
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
      const assertOwned = lease.assertOwned;
      const { backupDir, transaction } = await retain({}, assertOwned);
      originalBackup = backupDir;
      const publishedIdentity = await fs.lstat(targetDir, { bigint: true });
      let pauseConsumed = false;
      beforeRemove(async (target) => {
        if (!pauseConsumed && isInsideIdentity(target, publishedIdentity)) {
          pauseConsumed = true;
          paused.resolve();
          await release.promise;
        }
      });
      rollback = transaction.rollback();
      void rollback.catch(() => undefined);
      await awaitGateBeforeSettlement(
        paused.promise,
        rollback,
        "rollback completed before recursive removal paused",
      );
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
          beforePersistentApply: lease.assertOwned,
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
    }
  });

  it.each(["removal", "restoration"] as const)(
    "retains rollback progress for a retry after %s fails",
    async (failure) => {
      const { installBaseDir, targetDir, retain } = await createFixture("rollback-retry");
      const { backupDir, transaction } = await retain();
      const publishedIdentity = await fs.lstat(targetDir, { bigint: true });
      const error = ioError(`${failure} failed`);
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
          if (!injected && isInsideIdentity(path.join(this.rootReal, target), publishedIdentity)) {
            injected = true;
            throw error;
          }
          await remove.call(this, target, options);
        });
      } else {
        vi.spyOn(fs, "rename").mockImplementation((...args: Parameters<typeof fs.rename>) => {
          if (!injected && samePath(args[1], targetDir)) {
            injected = true;
            return Promise.reject(error);
          }
          return realRename(...args);
        });
      }

      const rollback = transaction.rollback();
      if (failure === "restoration") {
        await expect(rollback).rejects.toMatchObject({
          cause: error,
          message: expect.stringContaining(backupDir),
        });
      } else {
        await expect(rollback).rejects.toBe(error);
      }
      expect(injected).toBe(true);
      await expectText(backupDir, "old");
      await transaction.rollback();
      await expectText(targetDir, "old");
      expect(await fs.readdir(path.dirname(backupDir))).toEqual([]);
      expect(await listMatchingDirs(installBaseDir, ".openclaw-install-rollback-")).toEqual([]);
    },
  );

  it.each([false, true])(
    "keeps a one-shot backup retirement refusal (retained=%s)",
    async (retained) => {
      const { retain, sourceDir, targetDir } = await createFixture("settlement-refusal");
      await writeText(targetDir, "first", "a.txt");
      await writeText(targetDir, "retained", "b.txt");
      const refusal = ioError("owner refused");
      let armed = false;
      let triggered = false;
      const assertOwned = () => {
        if (armed) {
          armed = false;
          throw refusal;
        }
      };
      const backup = recordBackup();
      let liveIdentity: fsSync.BigIntStats | undefined;
      afterPublication(targetDir, async () => {
        liveIdentity = await fs.lstat(targetDir, { bigint: true });
      });
      beforeRemove((target) => {
        if (!triggered && samePath(target, path.join(backup.path, "b.txt"))) {
          triggered = true;
          armed = true;
        }
      });
      const transaction = retained
        ? await retain({}, assertOwned).then((result) => {
            backup.path = result.backupDir;
            return result.transaction;
          })
        : undefined;
      const retirement = transaction
        ? transaction.commit()
        : installPackageDir({
            ...updateOptions(sourceDir, targetDir),
            beforePersistentApply: assertOwned,
            afterBackup: backup.afterBackup,
          });
      await expect(retirement).rejects.toBe(refusal);
      await expectMissing(path.join(backup.path, "a.txt"));
      if (transaction) {
        for (const action of ["commit", "rollback", "commit", "rollback"] as const) {
          await expect(transaction[action]()).rejects.toBe(refusal);
        }
        await expectText(backup.path, "old");
      }
      await expectPackage(
        targetDir,
        "new",
        expectDefined(liveIdentity, "published package identity"),
      );
      await expectText(backup.path, "retained", "b.txt");
    },
  );

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
        await withPluginLifecycleLease(leaseOptions, async (lease) => run(lease.assertOwned));
      }
    },
  );

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
      let callerActive = true;
      const sourceCleanupError = ioError("published source cleanup failed");
      const callerError = new Error("initiating caller closed after publication");
      const published = afterPublication(targetDir, () => {
        if (failure === "caller revocation") {
          callerActive = false;
        }
      });
      const cleanupFailed = failUnlinkOnce(
        (file) =>
          failure === "source cleanup" &&
          published() &&
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

      expect(published()).toBe(true);
      expect(failure === "caller revocation" ? !callerActive : cleanupFailed()).toBe(true);
      expectFailure(
        result,
        failure === "source cleanup" ? sourceCleanupError.message : callerError.message,
      );
      if (mode === "update") {
        await expectText(targetDir, "old");
      } else {
        await expectMissing(targetDir);
      }
      await expectText(sourceDir, "new");
    },
  );

  it("restores the original when a publication assertion returns a Promise", async () => {
    const { install, sourceDir, targetDir } = await createFixture("async-publication-assertion");
    const original = await fs.lstat(targetDir, { bigint: true });
    let armed = false;
    let backupDir = "";
    const result = await install(
      {
        sourceHardlinks: "package-manager",
        afterBackup: async (directory) => {
          backupDir = directory;
          armed = true;
          return { ok: true as const };
        },
        // Deliberately return an invalid async result to exercise the runtime contract guard.
        beforePersistentApply(): unknown {
          return armed ? Promise.resolve() : undefined;
        },
      },
      () => {},
    );
    expect(result).toEqual({
      ok: false,
      error: "failed to copy plugin: TypeError: mutation authority must be synchronous",
    });
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
      const cleanupError = ioError("restored backup cleanup failed");
      const restored = afterPublication(targetDir, () => {});
      const cleanupFailed = failUnlinkOnce(
        (file) => restored() && samePath(path.dirname(String(file)), backupDir),
        cleanupError,
      );

      const rollbackError = await transaction.rollback().then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(restored()).toBe(true);
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
    const backup = recordBackup();
    let pendingInstall: ReturnType<typeof installPackageDir> | undefined;
    const published = afterPublication(targetDir, async () => {
      reachedPublication.resolve();
      await resumeCleanup.promise;
    });

    const lifecycle = withPluginLifecycleLease(leaseOptions, async (lease) => {
      const assertOwned = lease.assertOwned;
      pendingInstall = install(
        {
          sourceHardlinks: "reject",
          afterBackup: backup.afterBackup,
        },
        assertOwned,
      );
      await awaitGateBeforeSettlement(
        reachedPublication.promise,
        pendingInstall,
        "install finished before publication paused",
      );
      return assertOwned;
    });

    try {
      const assertClosedOwner = await lifecycle;
      expect(assertClosedOwner).toThrow();
      const publishedIdentity = await fs.lstat(targetDir, { bigint: true });
      resumeCleanup.resolve();
      const result = await expectDefined(pendingInstall, "in-flight install");
      expect(published()).toBe(true);
      expectFailure(result, "published", targetDir, backup.path);
      await expectPackage(targetDir, "new", publishedIdentity);
      expect(backup.path).not.toBe("");
      await expectText(backup.path, "old");
    } finally {
      resumeCleanup.resolve();
      await lifecycle.catch(() => undefined);
      await pendingInstall?.catch(() => undefined);
    }
  });
});
