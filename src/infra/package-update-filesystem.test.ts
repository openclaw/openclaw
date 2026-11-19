import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { FsSafeError } from "@openclaw/fs-safe/errors";
import { root as fsSafeRoot, type Root } from "@openclaw/fs-safe/root";
import { __setFsSafeTestHooksForTest } from "@openclaw/fs-safe/test-hooks";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  activateStagedNpmPackageRoot,
  copyPackagePathEntry,
  discardPackageUpdateBackup,
  removePackagePath,
  restoreNpmPackageRoot,
} from "./package-update-filesystem.js";
import { interceptStagedFileSync } from "./package-update-sync.test-support.js";
import * as retry from "./retry.js";

const runRetry = retry.retryAsync;

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  __setFsSafeTestHooksForTest(undefined);
  vi.restoreAllMocks();
});

let root: string, source: string, destination: string, backup: string, marker: string;
let prototype: Root;
beforeEach(async () => {
  root = await fs.realpath(dirs.make("package-filesystem-"));
  source = path.join(root, "source");
  destination = path.join(root, "destination");
  backup = path.join(root, ".openclaw.backup");
  marker = path.join(backup, "marker.txt");
  prototype = Object.getPrototypeOf(await fsSafeRoot(root)) as Root;
});

async function writeLaunchers(replacement = "replacement", live = "live") {
  await writeFiles({ source: replacement, destination: live });
}

async function writeFiles(files: Record<string, string>) {
  for (const [relative, contents] of Object.entries(files)) {
    const file = path.join(root, relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, contents);
  }
}

async function writeBackup(contents?: string) {
  await fs.mkdir(backup);
  if (contents !== undefined) {
    await fs.writeFile(marker, contents);
  }
}

async function expectFile(file: string, contents: string) {
  expect(await fs.readFile(file, "utf8")).toBe(contents);
}

async function expectMissing(file: string) {
  await expect(fs.lstat(file)).rejects.toHaveProperty("code", "ENOENT");
}

async function expectEntries(directory: string, entries: string[]) {
  expect((await fs.readdir(directory)).toSorted()).toEqual(entries);
}

function errno(message: string, code: string) {
  return Object.assign(new Error(message), { code });
}

function interceptCopy(after: (owner: Root, target: string) => Promise<void>, once = false) {
  // oxlint-disable-next-line typescript/unbound-method -- Reapplied with the intercepted Root receiver.
  const copy = prototype.copyIn;
  const spy = vi.spyOn(prototype, "copyIn");
  return spy[once ? "mockImplementationOnce" : "mockImplementation"](async function (
    this: Root,
    ...args
  ) {
    await copy.call(this, ...args);
    await after(this, args[0]);
  });
}

function assertOwner(revoked: () => boolean, refusal: Error) {
  return () => {
    if (revoked()) {
      throw refusal;
    }
  };
}

function copyEntry(assertCurrent?: () => void, beforePublish?: (staged: string) => void) {
  return copyPackagePathEntry(source, destination, assertCurrent, beforePublish);
}

function discardBackup(assertCurrent?: () => void) {
  return discardPackageUpdateBackup(backup, "old package", root, assertCurrent);
}

it("keeps forced package cleanup idempotent when the parent is already absent", async () => {
  const parent = path.join(root, "missing");
  const assertCurrent = vi.fn();

  await expect(
    removePackagePath(path.join(parent, "package"), assertCurrent),
  ).resolves.toBeUndefined();

  expect(assertCurrent).toHaveBeenCalled();
  await expectMissing(parent);
});

it.runIf(process.platform !== "win32")(
  "refuses unjournaled symlink activation revoked during canonical source resolution",
  async () => {
    await writeFiles({ "target/marker.txt": "candidate" });
    await fs.symlink("target", source);
    let revoked = false;
    const realpath = fs.realpath.bind(fs);
    vi.spyOn(fs, "realpath").mockImplementation(async (...args) => {
      const resolved = await realpath(...args);
      if (String(args[0]) === source) {
        revoked = true;
      }
      return resolved;
    });
    const published = vi.fn();
    await expect(
      activateStagedNpmPackageRoot(source, destination, undefined, {
        assertCaller: assertOwner(() => revoked, errno("owner revoked", "EXDEV")),
        onPublished: published,
        warnings: [],
      }),
    ).rejects.toThrow("owner revoked");
    expect(published).not.toHaveBeenCalled();
    await expectMissing(destination);
    expect(await fs.readlink(source)).toBe("target");
  },
);

it.each(["copy", "remove", "activate", "restore", "discard"] as const)(
  "rejects a returned Promise at the raw %s authority boundary before filesystem effects",
  async (operation) => {
    const live = path.join(root, "live");
    await writeFiles({ "source/marker.txt": "source", "live/marker.txt": "live" });
    const copy = vi.spyOn(prototype, "copyIn");
    const unlink = vi.spyOn(fs, "unlink");
    const rmdir = vi.spyOn(fs, "rmdir");
    const rename = vi.spyOn(fs, "rename");
    const assertCurrent = vi.fn<() => unknown>(() => Promise.resolve());
    const mutations = {
      copy: () => copyPackagePathEntry(source, destination, assertCurrent),
      remove: () => removePackagePath(source, assertCurrent),
      activate: () => activateStagedNpmPackageRoot(source, destination, assertCurrent),
      restore: () =>
        restoreNpmPackageRoot({
          liveRoot: live,
          backupRoot: source,
          displacedRoot: destination,
          candidatePresent: true,
          assertCurrent,
        }),
      discard: () => discardPackageUpdateBackup(source, "backup", root, assertCurrent),
    };
    await expect(async () => mutations[operation]()).rejects.toThrow(TypeError);

    expect(assertCurrent).toHaveBeenCalledOnce();
    expect([copy, unlink, rmdir, rename].map((spy) => spy.mock.calls)).toEqual([[], [], [], []]);
    await expectFile(path.join(source, "marker.txt"), "source");
    await expectFile(path.join(live, "marker.txt"), "live");
    await expectMissing(destination);
  },
);

it.runIf(process.platform === "darwin").each([0o700, 0o755])(
  "preserves symlink mode %s without following its target",
  async (mode) => {
    const target = path.join(root, "target");
    await fs.writeFile(target, "target contents", { mode: 0o640 });
    await fs.symlink("target", source);
    await fs.lchmod(source, mode);
    const targetStat = await fs.stat(target);
    const symlink = fs.symlink.bind(fs);
    vi.spyOn(fs, "symlink").mockImplementation(async (...args) => {
      await symlink(...args);
      await fs.lchmod(args[1], mode === 0o700 ? 0o755 : 0o700);
    });

    await copyEntry();
    expect(await fs.readlink(destination)).toBe("target");
    expect((await fs.lstat(destination)).mode).toBe((await fs.lstat(source)).mode);
    expect((await fs.stat(target)).mode).toBe(targetStat.mode);
    await expectFile(target, "target contents");
    await fs.unlink(target);
    await copyEntry();
    expect((await fs.lstat(destination)).mode).toBe((await fs.lstat(source)).mode);
    expect(await fs.readlink(destination)).toBe("target");
  },
);

it.runIf(process.platform === "darwin").each([
  { operation: "lchmod", code: "EPERM", continues: true },
  { operation: "lchown", code: "EPERM", continues: true },
  { operation: "lchmod", code: "ENOSYS", continues: true },
  { operation: "lchmod", code: "EIO", continues: false },
] as const)(
  "handles symlink $operation failure $code without following the target",
  async ({ operation, code, continues }) => {
    await fs.symlink("missing", source);
    await fs.writeFile(destination, "live launcher");
    vi.spyOn(fs, operation).mockRejectedValueOnce(errno("link metadata denied", code));

    if (continues) {
      await expect(copyEntry()).resolves.toBeUndefined();
      expect(await fs.readlink(destination)).toBe("missing");
    } else {
      await expect(copyEntry()).rejects.toThrow("link metadata denied");
      await expectFile(destination, "live launcher");
    }
    await expectEntries(root, ["destination", "source"]);
  },
);

it("keeps the live launcher intact when its replacement copy is interrupted", async () => {
  await writeLaunchers();
  const copy = vi.spyOn(prototype, "copyIn").mockImplementationOnce(async function (
    this: Root,
    target,
  ) {
    await fs.writeFile(path.join(this.rootReal, target), "partial launcher");
    throw new Error("interrupted launcher copy");
  });

  await expect(copyEntry()).rejects.toThrow("interrupted launcher copy");
  expect(copy).toHaveBeenCalledOnce();
  await expectFile(destination, "live");
  await expectEntries(root, ["destination", "source"]);

  copy.mockRestore();
  await copyEntry();
  await expectFile(destination, "replacement");
});

it("keeps the live launcher intact when an ordinary copy cannot sync its staged file", async () => {
  await writeLaunchers("replacement launcher\n", "live launcher\n");
  const failure = errno("staged launcher sync failed", "EIO");
  const probe = interceptStagedFileSync(root, failure);

  await expect(copyEntry()).rejects.toHaveProperty("cause", failure);

  expect(probe.refused).toBe(1);
  await expectFile(source, "replacement launcher\n");
  await expectFile(destination, "live launcher\n");
  await expectEntries(root, ["destination", "source"]);
});

it("stages a complete directory with independent hardlinked files and preserved modes", async () => {
  await writeFiles({
    "source/nested/launcher": "launcher bytes",
    "destination/obsolete.txt": "obsolete",
  });
  const original = path.join(source, "nested", "launcher");
  await fs.chmod(original, 0o751);
  await fs.link(original, path.join(root, "retained-hardlink"));
  await fs.chmod(path.join(source, "nested"), 0o750);

  await copyEntry();

  expect(await fs.readdir(destination)).toEqual(["nested"]);
  const published = path.join(destination, "nested", "launcher");
  await expectFile(published, "launcher bytes");
  expect((await fs.lstat(published, { bigint: true })).ino).not.toBe(
    (await fs.lstat(original, { bigint: true })).ino,
  );
  expect((await fs.stat(published)).mode).toBe((await fs.stat(original)).mode);
  expect((await fs.stat(path.join(destination, "nested"))).mode).toBe(
    (await fs.stat(path.join(source, "nested"))).mode,
  );
  await expectEntries(root, ["destination", "retained-hardlink", "source"]);
});

it.skipIf(process.platform === "win32")(
  "retains the directory-copy link contract without copying the linked target",
  async () => {
    await fs.mkdir(source);
    await fs.writeFile(path.join(root, "outside.txt"), "outside");
    await fs.symlink("../outside.txt", path.join(source, "link"));

    await copyEntry();

    expect(await fs.readlink(path.join(destination, "link"))).toBe(path.join(root, "outside.txt"));
    await expectFile(path.join(root, "outside.txt"), "outside");
  },
);

it("keeps the live tree intact and cleans private staging after copy authority closes", async () => {
  await writeFiles({
    "source/a.txt": "first replacement",
    "source/b.txt": "second replacement",
    "destination/live.txt": "live launcher",
  });
  const refused = new Error("copy owner closed");
  let revoked = false;
  const copied: string[] = [];
  const cleaned: string[] = [];
  interceptCopy(async (_owner, target) => {
    copied.push(path.basename(target));
    if (path.basename(target) === "a.txt") {
      revoked = true;
    }
  });
  __setFsSafeTestHooksForTest({
    beforeRootFallbackMutation(operation, target) {
      if (operation === "remove") {
        cleaned.push(path.basename(target));
      }
    },
  });

  await expect(copyEntry(assertOwner(() => revoked, refused))).rejects.toBe(refused);

  expect(revoked).toBe(true);
  expect(copied).toEqual(["a.txt"]);
  expect(cleaned).toContain("a.txt");
  expect(cleaned).not.toContain("live.txt");
  await expectFile(path.join(destination, "live.txt"), "live launcher");
  await expectEntries(root, ["destination", "source"]);
});

it("retains the first copy failure when private staging has been replaced", async () => {
  await writeLaunchers();
  const retained = path.join(root, "retained-stage");
  const refused = new Error("copy completion refused");
  let replaced = "";
  interceptCopy(async (owner) => {
    replaced = owner.rootReal;
    await fs.rename(replaced, retained);
    await fs.mkdir(replaced);
    await fs.writeFile(path.join(replaced, "foreign.txt"), "successor staging");
    throw refused;
  }, true);

  await expect(copyEntry()).rejects.toBe(refused);

  expect(replaced).not.toBe("");
  await expectFile(destination, "live");
  await expectFile(path.join(replaced, "foreign.txt"), "successor staging");
  await expectFile(path.join(retained, "entry"), "replacement");
});

it.each([
  { name: "ENOENT", refusal: errno("owner missing", "ENOENT") },
  { name: "false", refusal: false },
])("does not retire a backup after a one-shot $name ownership refusal", async ({ refusal }) => {
  await writeFiles({ ".openclaw.backup/a.txt": "first", ".openclaw.backup/b.txt": "retained" });
  let armed = false;
  let refusals = 0;
  __setFsSafeTestHooksForTest({
    beforeRootFallbackMutation(operation, target) {
      if (operation === "remove" && path.basename(target) === "b.txt") {
        armed = true;
      }
    },
  });
  await expect(
    discardPackageUpdateBackup(backup, "backup", root, () => {
      if (armed && refusals === 0) {
        refusals += 1;
        // oxlint-disable-next-line typescript/only-throw-error -- Non-Error owner refusals must retain their exact identity.
        throw refusal;
      }
    }),
  ).rejects.toBe(refusal);
  expect(refusals).toBe(1);
  await expectFile(path.join(backup, "b.txt"), "retained");
  await expectMissing(path.join(backup, "a.txt"));
  await expectMissing(path.join(root, ".openclaw-backup"));
});

it("retains delayed retirement for an ordinary backup removal I/O failure", async () => {
  await writeBackup("old");
  const remove = vi
    .spyOn(prototype, "remove")
    .mockRejectedValueOnce(errno("cleanup I/O failure", "EIO"));

  const warning = await discardBackup();

  expect(remove).toHaveBeenCalledOnce();
  expect(warning).toContain("for delayed cleanup");
  await expectFile(path.join(root, ".openclaw-backup", "marker.txt"), "old");
  await expectMissing(backup);
});

it("does not report retained backup when its final removal completes at the cleanup deadline", async () => {
  await writeBackup();
  const clock = vi.spyOn(performance, "now").mockReturnValue(0);
  const rmdir = fs.rmdir.bind(fs);
  vi.spyOn(fs, "rmdir").mockImplementation(async (...args) => {
    await rmdir(...args);
    if (String(args[0]) === backup) {
      clock.mockReturnValue(300_001);
    }
  });

  await expect(discardBackup()).resolves.toBeNull();
  await expectMissing(backup);
});

it.each([
  new FsSafeError("path-mismatch", "fixture removal identity changed"),
  errno("EACCES: fixture removal failed", "EACCES"),
])("preserves the original backup on a late removal failure: %s", async (refusal) => {
  await writeBackup("original");
  const clock = vi.spyOn(performance, "now").mockReturnValue(0);
  vi.spyOn(prototype, "remove").mockImplementationOnce(async () => {
    clock.mockReturnValue(300_001);
    throw refusal;
  });
  const rename = vi.spyOn(fs, "rename");
  const pending = discardBackup();
  if (refusal instanceof FsSafeError) {
    await expect(pending).rejects.toBe(refusal);
  } else {
    const warning = await pending;
    for (const part of ["cleanup budget expired", backup, refusal.message]) {
      expect(warning).toContain(part);
    }
  }
  expect(rename).not.toHaveBeenCalled();
  await expectFile(marker, "original");
});

it.each(["owner", "backup"] as const)(
  "does not downgrade a revoked %s to a cleanup deadline warning",
  async (revoked) => {
    await writeBackup("original");
    const entered = createDeferredCore();
    const release = createDeferredCore();
    const clock = vi.spyOn(performance, "now").mockReturnValue(0);
    const refusal = new Error("retirement owner revoked");
    let current = true;
    __setFsSafeTestHooksForTest({
      async beforeRootFallbackMutation(operation, target) {
        if (operation === "remove" && target === marker) {
          entered.resolve();
          await release.promise;
        }
      },
    });
    const pending = discardBackup(assertOwner(() => !current, refusal));
    try {
      await entered.promise;
      clock.mockReturnValue(300_001);
      if (revoked === "owner") {
        current = false;
      } else {
        await fs.rename(backup, path.join(root, "original-backup"));
        await fs.mkdir(backup);
        await fs.writeFile(marker, "successor");
      }
      release.resolve();
      if (revoked === "owner") {
        await expect(pending).rejects.toBe(refusal);
      } else {
        await expect(pending).rejects.toHaveProperty("code", "path-mismatch");
      }
      await expectFile(marker, revoked === "owner" ? "original" : "successor");
    } finally {
      release.resolve();
      await pending.catch(() => undefined);
    }
  },
);

it.each(["backup", "parent"] as const)(
  "does not retire a replacement %s after the last owned rmdir fails",
  async (replacement) => {
    const retained = path.join(dirs.make("package-backup-retained-"), "original");
    const retired = path.join(root, ".openclaw-backup");
    await writeBackup("obsolete");
    const original = await fs.lstat(backup, { bigint: true });
    const rmdir = fs.rmdir.bind(fs);
    let injections = 0;
    vi.spyOn(fs, "rmdir").mockImplementation(async (...args) => {
      if (String(args[0]) === backup) {
        injections += 1;
        expect(await fs.readdir(backup)).toEqual([]);
        await fs.rename(replacement === "backup" ? backup : root, retained);
        await writeFiles({ ".openclaw.backup/sentinel.txt": "successor" });
        throw errno("final backup removal failed", "EIO");
      }
      await rmdir(...args);
    });
    const rename = vi.spyOn(fs, "rename");

    await expect(discardBackup()).rejects.toHaveProperty("code", "path-mismatch");

    expect(injections).toBe(1);
    expect(rename.mock.calls.some(([, target]) => String(target) === retired)).toBe(false);
    await expectFile(path.join(backup, "sentinel.txt"), "successor");
    const retainedBackup =
      replacement === "backup" ? retained : path.join(retained, path.basename(backup));
    expect(await fs.lstat(retainedBackup, { bigint: true })).toMatchObject({
      dev: original.dev,
      ino: original.ino,
    });
    expect(await fs.readdir(retainedBackup)).toEqual([]);
    await expectMissing(retired);
  },
);

it("does not compensate a root rename after its original owner refused once", async () => {
  const liveRoot = path.join(root, "live");
  const backupRoot = path.join(root, "backup");
  const displacedRoot = path.join(root, "displaced");
  await writeFiles({ "live/marker.txt": "candidate", "backup/marker.txt": "original" });
  const rename = fs.rename.bind(fs);
  let displaced = false;
  let refusals = 0;
  const refused = errno("owner missing after displacement", "ENOENT");
  const renameSpy = vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
    await rename(from, to);
    displaced = true;
  });

  await expect(
    restoreNpmPackageRoot({
      liveRoot,
      backupRoot,
      displacedRoot,
      candidatePresent: true,
      assertCurrent: () => {
        if (displaced && refusals === 0) {
          refusals += 1;
          throw refused;
        }
      },
    }),
  ).rejects.toBe(refused);

  expect(refusals).toBe(1);
  expect(renameSpy).toHaveBeenCalledTimes(1);
  await expectMissing(liveRoot);
  await expectFile(path.join(displacedRoot, "marker.txt"), "candidate");
  await expectFile(path.join(backupRoot, "marker.txt"), "original");
});

function restoreRenameRetryHarness() {
  const wait = vi.fn(async () => {});
  vi.spyOn(retry, "retryAsync").mockImplementation((fn, options) =>
    runRetry(fn, { ...(typeof options === "object" ? options : {}), sleep: wait }),
  );
  return wait;
}

it("names the retained backup when publication fails without a candidate", async () => {
  const liveRoot = path.join(root, "live");
  const backupRoot = path.join(root, "backup");
  const displacedRoot = path.join(root, "displaced");
  await writeFiles({ "backup/marker.txt": "original" });
  vi.spyOn(fs, "rename").mockRejectedValue(errno("EXDEV: cross-device link", "EXDEV"));

  const failure = restoreNpmPackageRoot({
    liveRoot,
    backupRoot,
    displacedRoot,
    candidatePresent: false,
  });
  await expect(failure).rejects.toThrow(/is missing/u);
  const message = await failure.then(
    () => "",
    (error: unknown) => (error instanceof Error ? error.message : String(error)),
  );
  expect(message).toContain("EXDEV: cross-device link");
  expect(message).toContain(`moving ${backupRoot} to ${liveRoot}`);
  await expectMissing(liveRoot);
  await expectFile(path.join(backupRoot, "marker.txt"), "original");
});

it.each([
  ["owner", "update owner revoked"],
  ["retained backup", "package path changed"],
  ["live parent", "package path changed"],
] as const)("stops Windows package rename retries when the %s changes", async (change, refusal) => {
  const liveRoot = path.join(root, "live", "openclaw");
  const backupRoot = path.join(root, "backup");
  const stage = path.join(root, "stage", "openclaw");
  const activation = change === "live parent";
  await writeFiles({
    "live/openclaw/marker.txt": "candidate",
    "backup/marker.txt": "original",
    "stage/openclaw/marker.txt": "staged",
  });
  const wait = restoreRenameRetryHarness();
  const rename = fs.rename.bind(fs);
  const denied = activation ? stage : backupRoot;
  let attempts = 0;
  vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
    if (String(from) === denied && ++attempts === 1) {
      throw errno("EPERM: package is in use", "EPERM");
    }
    return rename(from, to);
  });
  wait.mockImplementationOnce(async () => {
    const replaced = activation ? path.dirname(liveRoot) : backupRoot;
    if (change !== "owner") {
      await rename(replaced, `${replaced}.retained`);
      await fs.mkdir(replaced);
    }
  });
  const revoked = () => change === "owner" && wait.mock.calls.length > 0;
  const assertCurrent = assertOwner(revoked, errno("update owner revoked", "EPERM"));

  await expect(
    activation
      ? activateStagedNpmPackageRoot(stage, path.join(root, "live", "next"), undefined, {
          assertCaller: assertCurrent,
          warnings: [],
          platform: "win32",
        })
      : restoreNpmPackageRoot({
          liveRoot,
          backupRoot,
          displacedRoot: path.join(root, "displaced"),
          candidatePresent: true,
          platform: "win32",
          assertCurrent,
        }),
  ).rejects.toThrow(refusal);

  expect(attempts).toBe(1);
  // Nothing moves after the refusal; a changed backup still gets its candidate back.
  const retained = change === "retained backup" ? `${backupRoot}.retained` : denied;
  await expectFile(path.join(retained, "marker.txt"), activation ? "staged" : "original");
  if (activation) {
    await expectMissing(path.join(root, "live", "next"));
  } else if (change === "owner") {
    await expectMissing(liveRoot);
  } else {
    await expectFile(path.join(liveRoot, "marker.txt"), "candidate");
    await expectMissing(path.join(root, "displaced"));
  }
});

it.each(["copy", "cleanup"] as const)(
  "retains an undefined %s failure through private copy cleanup",
  async (phase) => {
    const copyFailure = phase === "copy";
    const cleanupFailure = copyFailure ? new Error("cleanup failed after copy refusal") : undefined;
    await writeLaunchers();
    // oxlint-disable-next-line typescript/unbound-method -- Called below with the intercepted Root receiver to preserve its path and mutation authority.
    const copy = prototype.copyIn;
    // oxlint-disable-next-line typescript/unbound-method -- Called below with the intercepted Root receiver to preserve its path and mutation authority.
    const remove = prototype.remove;
    let staging = "";
    let cleanupAttempts = 0;
    const copySpy = vi.spyOn(prototype, "copyIn").mockImplementationOnce(function (
      this: Root,
      ...args
    ) {
      staging = this.rootReal;
      if (copyFailure) {
        // oxlint-disable-next-line typescript/only-throw-error -- Undefined must remain the original copy failure.
        throw undefined;
      }
      return copy.call(this, ...args);
    });
    vi.spyOn(prototype, "remove").mockImplementation(function (this: Root, relativePath, options) {
      if (path.basename(relativePath).startsWith(".openclaw-shim-stage-")) {
        cleanupAttempts += 1;
        // oxlint-disable-next-line typescript/only-throw-error -- An undefined cleanup failure must remain a failure.
        throw cleanupFailure;
      }
      return remove.call(this, relativePath, options);
    });
    const rename = vi.spyOn(fs, "rename");

    await expect(copyEntry()).rejects.toBe(undefined);
    expect(copySpy).toHaveBeenCalledOnce();
    expect(cleanupAttempts).toBe(1);
    expect(staging).not.toBe("");
    expect(rename.mock.calls.filter(([, to]) => String(to) === destination)).toHaveLength(
      copyFailure ? 0 : 1,
    );
    await expectFile(source, "replacement");
    await expectFile(destination, copyFailure ? "live" : "replacement");
    expect(await fs.readdir(staging)).toEqual([]);
  },
);

it.each(["publish", "revoke", "replace"] as const)(
  "preserves live ownership through the journal publication hook: %s",
  async (action) => {
    await writeLaunchers("sealed launcher", "live launcher");
    const retained = path.join(root, "retained");
    const refusal = new Error("journal owner revoked");
    let revoked = false;
    const beforePublish = vi.fn((staged: string) => {
      expect(fsSync.readFileSync(staged, "utf8")).toBe("sealed launcher");
      expect(fsSync.readFileSync(destination, "utf8")).toBe("live launcher");
      if (action === "revoke") {
        revoked = true;
      } else if (action === "replace") {
        fsSync.renameSync(destination, retained);
        fsSync.writeFileSync(destination, "foreign launcher");
      }
    });
    const result = copyEntry(
      assertOwner(() => revoked, refusal),
      beforePublish,
    );
    if (action === "publish") {
      await expect(result).resolves.toBeUndefined();
    } else if (action === "revoke") {
      await expect(result).rejects.toBe(refusal);
    } else {
      await expect(result).rejects.toHaveProperty("code", "path-mismatch");
      await expectFile(retained, "live launcher");
    }
    expect(beforePublish).toHaveBeenCalledOnce();
    await expectFile(source, "sealed launcher");
    await expectFile(
      destination,
      action === "publish"
        ? "sealed launcher"
        : action === "revoke"
          ? "live launcher"
          : "foreign launcher",
    );
    await expectEntries(
      root,
      action === "replace" ? ["destination", "retained", "source"] : ["destination", "source"],
    );
  },
);
