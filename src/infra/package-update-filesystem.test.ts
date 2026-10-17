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

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  __setFsSafeTestHooksForTest(undefined);
  vi.restoreAllMocks();
});

let root: string, source: string, destination: string, backup: string, marker: string;
beforeEach(async () => {
  root = await fs.realpath(dirs.make("package-filesystem-"));
  source = path.join(root, "source");
  destination = path.join(root, "destination");
  backup = path.join(root, ".openclaw.backup");
  marker = path.join(backup, "marker.txt");
});

async function writeLaunchers(replacement = "replacement", live = "live") {
  await fs.writeFile(source, replacement);
  await fs.writeFile(destination, live);
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

it("keeps forced package cleanup idempotent when the parent is already absent", async () => {
  const parent = path.join(root, "missing");
  const assertCurrent = vi.fn();

  await expect(
    removePackagePath(path.join(parent, "package"), assertCurrent),
  ).resolves.toBeUndefined();

  expect(assertCurrent).toHaveBeenCalled();
  await expectMissing(parent);
});

it.each(["copy", "remove", "activate", "restore", "discard"] as const)(
  "rejects a returned Promise at the raw %s authority boundary before filesystem effects",
  async (operation) => {
    const live = path.join(root, "live");
    await fs.mkdir(source);
    await fs.mkdir(live);
    await fs.writeFile(path.join(source, "marker.txt"), "source");
    await fs.writeFile(path.join(live, "marker.txt"), "live");
    const prototype = Object.getPrototypeOf(await fsSafeRoot(root)) as Root;
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
    const mutation = async () => {
      await mutations[operation]();
    };

    await expect(mutation()).rejects.toThrow(TypeError);

    expect(assertCurrent).toHaveBeenCalledOnce();
    expect(copy).not.toHaveBeenCalled();
    expect(unlink).not.toHaveBeenCalled();
    expect(rmdir).not.toHaveBeenCalled();
    expect(rename).not.toHaveBeenCalled();
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

    await copyPackagePathEntry(source, destination);
    expect(await fs.readlink(destination)).toBe("target");
    expect((await fs.lstat(destination)).mode).toBe((await fs.lstat(source)).mode);
    expect((await fs.stat(target)).mode).toBe(targetStat.mode);
    await expectFile(target, "target contents");
    await fs.unlink(target);
    await copyPackagePathEntry(source, destination);
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
    vi.spyOn(fs, operation).mockRejectedValueOnce(
      Object.assign(new Error("link metadata denied"), { code }),
    );

    if (continues) {
      await expect(copyPackagePathEntry(source, destination)).resolves.toBeUndefined();
      expect(await fs.readlink(destination)).toBe("missing");
    } else {
      await expect(copyPackagePathEntry(source, destination)).rejects.toThrow(
        "link metadata denied",
      );
      await expectFile(destination, "live launcher");
    }
    await expectEntries(root, ["destination", "source"]);
  },
);

it("keeps the live launcher intact when its replacement copy is interrupted", async () => {
  const retainedLauncher = path.join(root, "retained-launcher");
  const liveLauncher = path.join(root, "live-launcher");
  await fs.writeFile(retainedLauncher, "previous launcher\n");
  await fs.writeFile(liveLauncher, "candidate launcher\n");
  const prototype = Object.getPrototypeOf(await fsSafeRoot(root)) as Root;
  const copy = vi.spyOn(prototype, "copyIn").mockImplementationOnce(async function (
    this: Root,
    target,
  ) {
    await fs.writeFile(path.join(this.rootReal, target), "partial launcher");
    throw new Error("interrupted launcher copy");
  });

  await expect(copyPackagePathEntry(retainedLauncher, liveLauncher)).rejects.toThrow(
    "interrupted launcher copy",
  );
  expect(copy).toHaveBeenCalledOnce();
  await expectFile(liveLauncher, "candidate launcher\n");
  await expectEntries(root, ["live-launcher", "retained-launcher"]);

  copy.mockRestore();
  await copyPackagePathEntry(retainedLauncher, liveLauncher);
  await expectFile(liveLauncher, "previous launcher\n");
});

it("keeps the live launcher intact when an ordinary copy cannot sync its staged file", async () => {
  await writeLaunchers("replacement launcher\n", "live launcher\n");
  const failure = Object.assign(new Error("staged launcher sync failed"), { code: "EIO" });
  let refused = 0;
  const refuseStagedFileSync = (fd: number) => {
    const identity = fsSync.fstatSync(fd, { bigint: true });
    if (!identity.isFile()) {
      return;
    }
    const staged = fsSync
      .readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith(".openclaw-shim-stage-"))
      .some((directory) =>
        fsSync.readdirSync(path.join(root, directory.name)).some((entry) => {
          const current = fsSync.lstatSync(path.join(root, directory.name, entry), {
            bigint: true,
          });
          return current.isFile() && current.dev === identity.dev && current.ino === identity.ino;
        }),
      );
    if (staged) {
      refused++;
      throw failure;
    }
  };
  const open = fs.open;
  vi.spyOn(fs, "open").mockImplementation(async (...args) => {
    const handle = await open(...args);
    const sync = handle.sync.bind(handle);
    vi.spyOn(handle, "sync").mockImplementation(async () => {
      refuseStagedFileSync(handle.fd);
      await sync();
    });
    return handle;
  });
  // Native fs-safe copies flush raw descriptors; the fallback uses FileHandle.sync.
  const fsync = fsSync.fsyncSync;
  vi.spyOn(fsSync, "fsyncSync").mockImplementation((fd) => {
    refuseStagedFileSync(fd);
    fsync(fd);
  });

  await expect(copyPackagePathEntry(source, destination)).rejects.toHaveProperty("cause", failure);

  expect(refused).toBe(1);
  await expectFile(source, "replacement launcher\n");
  await expectFile(destination, "live launcher\n");
  await expectEntries(root, ["destination", "source"]);
});

it("stages a complete directory with independent hardlinked files and preserved modes", async () => {
  await fs.mkdir(path.join(source, "nested"), { recursive: true });
  await fs.mkdir(destination);
  await fs.writeFile(path.join(destination, "obsolete.txt"), "obsolete");
  const original = path.join(source, "nested", "launcher");
  await fs.writeFile(original, "launcher bytes", { mode: 0o751 });
  await fs.link(original, path.join(root, "retained-hardlink"));
  await fs.chmod(path.join(source, "nested"), 0o750);

  await copyPackagePathEntry(source, destination);

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

    await copyPackagePathEntry(source, destination);

    expect(await fs.readlink(path.join(destination, "link"))).toBe(path.join(root, "outside.txt"));
    await expectFile(path.join(root, "outside.txt"), "outside");
  },
);

it("keeps the live tree intact and cleans private staging after copy authority closes", async () => {
  await fs.mkdir(source);
  await fs.mkdir(destination);
  await fs.writeFile(path.join(source, "a.txt"), "first replacement");
  await fs.writeFile(path.join(source, "b.txt"), "second replacement");
  await fs.writeFile(path.join(destination, "live.txt"), "live launcher");
  const refused = new Error("copy owner closed");
  let revoked = false;
  const copied: string[] = [];
  const cleaned: string[] = [];
  const prototype = Object.getPrototypeOf(await fsSafeRoot(root)) as Root;
  // oxlint-disable-next-line typescript/unbound-method -- Keep the real copy receiver and authority options.
  const copy = prototype.copyIn;
  vi.spyOn(prototype, "copyIn").mockImplementation(async function (
    this: Root,
    target,
    copySource,
    options,
  ) {
    await copy.call(this, target, copySource, options);
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

  await expect(
    copyPackagePathEntry(source, destination, () => {
      if (revoked) {
        throw refused;
      }
    }),
  ).rejects.toBe(refused);

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
  const prototype = Object.getPrototypeOf(await fsSafeRoot(root)) as Root;
  // oxlint-disable-next-line typescript/unbound-method -- Called below with the intercepted Root receiver to preserve its path and mutation authority.
  const copy = prototype.copyIn;
  const refused = new Error("copy completion refused");
  let replaced = "";
  vi.spyOn(prototype, "copyIn").mockImplementationOnce(async function (
    this: Root,
    target,
    from,
    options,
  ) {
    await copy.call(this, target, from, options);
    replaced = this.rootReal;
    await fs.rename(replaced, retained);
    await fs.mkdir(replaced);
    await fs.writeFile(path.join(replaced, "foreign.txt"), "successor staging");
    throw refused;
  });

  await expect(copyPackagePathEntry(source, destination)).rejects.toBe(refused);

  expect(replaced).not.toBe("");
  await expectFile(destination, "live");
  await expectFile(path.join(replaced, "foreign.txt"), "successor staging");
  await expectFile(path.join(retained, "entry"), "replacement");
});

it.each([
  { name: "ENOENT", refusal: Object.assign(new Error("owner missing"), { code: "ENOENT" }) },
  { name: "false", refusal: false },
])("does not retire a backup after a one-shot $name ownership refusal", async ({ refusal }) => {
  await writeBackup();
  await fs.writeFile(path.join(backup, "a.txt"), "first");
  await fs.writeFile(path.join(backup, "b.txt"), "retained");
  let armed = false;
  let refusals = 0;
  __setFsSafeTestHooksForTest({
    beforeRootFallbackMutation(operation, target) {
      if (operation === "remove" && path.basename(target) === "b.txt") {
        armed = true;
      }
    },
  });
  const outcome = await discardPackageUpdateBackup(backup, "backup", root, () => {
    if (armed && refusals === 0) {
      refusals += 1;
      // oxlint-disable-next-line typescript/only-throw-error -- Non-Error owner refusals must retain their exact identity.
      throw refusal;
    }
  }).then(
    () => ({ ok: true as const }),
    (error: unknown) => ({ ok: false as const, error }),
  );

  expect(outcome.ok).toBe(false);
  expect(outcome.ok ? undefined : outcome.error).toBe(refusal);
  expect(refusals).toBe(1);
  await expectFile(path.join(backup, "b.txt"), "retained");
  await expectMissing(path.join(backup, "a.txt"));
  await expectMissing(path.join(root, ".openclaw-backup"));
});

it("retains delayed retirement for an ordinary backup removal I/O failure", async () => {
  await writeBackup("old");
  const prototype = Object.getPrototypeOf(await fsSafeRoot(root)) as Root;
  const remove = vi
    .spyOn(prototype, "remove")
    .mockRejectedValueOnce(Object.assign(new Error("cleanup I/O failure"), { code: "EIO" }));

  const warning = await discardPackageUpdateBackup(backup, "backup", root);

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

  await expect(discardPackageUpdateBackup(backup, "old package", root)).resolves.toBeNull();
  await expectMissing(backup);
});

it("preserves an observed filesystem identity refusal when the cleanup budget expires", async () => {
  await writeBackup("original");
  const clock = vi.spyOn(performance, "now").mockReturnValue(0);
  const prototype = Object.getPrototypeOf(await fsSafeRoot(root)) as Root;
  const refusal = new FsSafeError("path-mismatch", "fixture removal identity changed");
  vi.spyOn(prototype, "remove").mockImplementationOnce(async () => {
    clock.mockReturnValue(300_001);
    throw refusal;
  });

  await expect(discardPackageUpdateBackup(backup, "old package", root)).rejects.toBe(refusal);
  await expectFile(path.join(backup, "marker.txt"), "original");
});

it("retains the original backup when removal fails after the cleanup budget", async () => {
  const code = "EACCES";
  await writeBackup("original");
  const clock = vi.spyOn(performance, "now").mockReturnValue(0);
  const prototype = Object.getPrototypeOf(await fsSafeRoot(root)) as Root;
  vi.spyOn(prototype, "remove").mockImplementationOnce(async () => {
    clock.mockReturnValue(300_001);
    throw Object.assign(new Error(`${code}: fixture removal failed`), { code });
  });
  const rename = vi.spyOn(fs, "rename");

  const warning = await discardPackageUpdateBackup(backup, "old package", root);

  expect(warning).toContain("cleanup budget expired");
  expect(warning).toContain(backup);
  expect(warning).toContain(`${code}: fixture removal failed`);
  expect(rename).not.toHaveBeenCalled();
  await expectFile(path.join(backup, "marker.txt"), "original");
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
    const pending = discardPackageUpdateBackup(backup, "old package", root, () => {
      if (!current) {
        throw refusal;
      }
    });
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
      expect(await fs.readFile(marker, "utf8")).toBe(
        revoked === "owner" ? "original" : "successor",
      );
    } finally {
      release.resolve();
      await pending.catch(() => undefined);
    }
  },
);

it.each(["backup", "parent"] as const)(
  "does not retire a replacement %s after the last owned rmdir fails",
  async (replacement) => {
    const sandbox = dirs.make("package-backup-replacement-");
    await fs.mkdir(path.join(sandbox, "global"));
    const replacementRoot = await fs.realpath(path.join(sandbox, "global"));
    const replacementBackup = path.join(replacementRoot, ".openclaw.backup");
    const retired = path.join(replacementRoot, ".openclaw-backup");
    const retained = path.join(path.dirname(replacementRoot), "retained");
    await fs.mkdir(replacementBackup);
    await fs.writeFile(path.join(replacementBackup, "old.txt"), "obsolete");
    const original = await fs.lstat(replacementBackup, { bigint: true });
    const rmdir = fs.rmdir.bind(fs);
    let injections = 0;
    vi.spyOn(fs, "rmdir").mockImplementation(async (...args) => {
      if (String(args[0]) === replacementBackup) {
        injections += 1;
        // The owned leaf was removed first. Race the final directory operation,
        // then return an ordinary errno that used to admit the rename fallback.
        expect(await fs.readdir(replacementBackup)).toEqual([]);
        await fs.rename(replacement === "backup" ? replacementBackup : replacementRoot, retained);
        await fs.mkdir(replacementBackup, { recursive: true });
        await fs.writeFile(path.join(replacementBackup, "sentinel.txt"), "successor");
        throw Object.assign(new Error("final backup removal failed"), { code: "EIO" });
      }
      await rmdir(...args);
    });
    const rename = vi.spyOn(fs, "rename");

    await expect(
      discardPackageUpdateBackup(replacementBackup, "old package", replacementRoot),
    ).rejects.toHaveProperty("code", "path-mismatch");

    expect(injections).toBe(1);
    expect(rename.mock.calls.some(([, target]) => String(target) === retired)).toBe(false);
    await expectFile(path.join(replacementBackup, "sentinel.txt"), "successor");
    const retainedBackup =
      replacement === "backup" ? retained : path.join(retained, path.basename(replacementBackup));
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
  await fs.mkdir(liveRoot);
  await fs.mkdir(backupRoot);
  await fs.writeFile(path.join(liveRoot, "marker.txt"), "candidate");
  await fs.writeFile(path.join(backupRoot, "marker.txt"), "original");
  const rename = fs.rename.bind(fs);
  let displaced = false;
  let refusals = 0;
  const refused = Object.assign(new Error("owner missing after displacement"), { code: "ENOENT" });
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

it.each([
  {
    name: "an undefined copy failure before a cleanup failure",
    copyFailure: { error: undefined },
    cleanupFailure: { error: new Error("cleanup failed after copy refusal") },
  },
  {
    name: "a sole undefined cleanup failure",
    copyFailure: undefined,
    cleanupFailure: { error: undefined },
  },
])("retains $name through private copy cleanup", async ({ copyFailure, cleanupFailure }) => {
  await writeLaunchers();
  const prototype = Object.getPrototypeOf(await fsSafeRoot(root)) as Root;
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
      throw copyFailure.error;
    }
    return copy.call(this, ...args);
  });
  vi.spyOn(prototype, "remove").mockImplementation(function (this: Root, relativePath, options) {
    if (path.basename(relativePath).startsWith(".openclaw-shim-stage-")) {
      cleanupAttempts += 1;
      // oxlint-disable-next-line typescript/only-throw-error -- An undefined cleanup failure must remain a failure.
      throw cleanupFailure.error;
    }
    return remove.call(this, relativePath, options);
  });
  const rename = vi.spyOn(fs, "rename");

  const outcome = await copyPackagePathEntry(source, destination).then(
    () => ({ ok: true as const }),
    (error: unknown) => ({ ok: false as const, error }),
  );

  expect(outcome.ok).toBe(false);
  expect(outcome.ok ? undefined : outcome.error).toBe((copyFailure ?? cleanupFailure)?.error);
  expect(copySpy).toHaveBeenCalledOnce();
  expect(cleanupAttempts).toBe(1);
  expect(staging).not.toBe("");
  expect(rename.mock.calls.filter(([, to]) => String(to) === destination)).toHaveLength(
    copyFailure ? 0 : 1,
  );
  await expectFile(source, "replacement");
  await expectFile(destination, copyFailure ? "live" : "replacement");
  expect(await fs.readdir(staging)).toEqual([]);
});

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
    const result = copyPackagePathEntry(
      source,
      destination,
      () => {
        if (revoked) {
          throw refusal;
        }
      },
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
    expect(await fs.readFile(destination, "utf8")).toBe(
      action === "publish"
        ? "sealed launcher"
        : action === "revoke"
          ? "live launcher"
          : "foreign launcher",
    );
    expect((await fs.readdir(root)).toSorted()).toEqual(
      action === "replace" ? ["destination", "retained", "source"] : ["destination", "source"],
    );
  },
);
