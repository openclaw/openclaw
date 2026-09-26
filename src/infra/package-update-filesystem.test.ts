import fs from "node:fs/promises";
import path from "node:path";
import { root as fsSafeRoot, type Root } from "@openclaw/fs-safe/root";
import { __setFsSafeTestHooksForTest } from "@openclaw/fs-safe/test-hooks";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
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

it("keeps forced package cleanup idempotent when the parent is already absent", async () => {
  const root = dirs.make("package-cleanup-missing-");
  const parent = path.join(root, "missing");
  const assertCurrent = vi.fn();

  await expect(
    removePackagePath(path.join(parent, "package"), assertCurrent),
  ).resolves.toBeUndefined();

  expect(assertCurrent).toHaveBeenCalled();
  await expect(fs.lstat(parent)).rejects.toHaveProperty("code", "ENOENT");
});

it.each(["copy", "remove", "activate", "restore", "discard"] as const)(
  "rejects a returned Promise at the raw %s authority boundary before filesystem effects",
  async (operation) => {
    const root = dirs.make("package-async-authority-");
    const source = path.join(root, "source");
    const live = path.join(root, "live");
    const destination = path.join(root, "destination");
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
    expect(await fs.readFile(path.join(source, "marker.txt"), "utf8")).toBe("source");
    expect(await fs.readFile(path.join(live, "marker.txt"), "utf8")).toBe("live");
    await expect(fs.lstat(destination)).rejects.toHaveProperty("code", "ENOENT");
  },
);

it.runIf(process.platform === "darwin").each([0o700, 0o755])(
  "preserves symlink mode %s without following its target",
  async (mode) => {
    const root = dirs.make("package-launcher-mode-");
    const source = path.join(root, "source");
    const destination = path.join(root, "destination");
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
    expect(await fs.readFile(target, "utf8")).toBe("target contents");
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
    const root = dirs.make("package-launcher-metadata-");
    const source = path.join(root, "source");
    const destination = path.join(root, "destination");
    await fs.symlink("missing", source);
    await fs.writeFile(destination, "live launcher");
    vi.spyOn(fs, operation).mockRejectedValueOnce(
      Object.assign(new Error("link metadata denied"), { code }),
    );

    if (continues) {
      await expect(copyPackagePathEntry(source, destination)).resolves.toEqual({
        ownershipPreserved: operation !== "lchown",
      });
      expect(await fs.readlink(destination)).toBe("missing");
    } else {
      await expect(copyPackagePathEntry(source, destination)).rejects.toThrow(
        "link metadata denied",
      );
      expect(await fs.readFile(destination, "utf8")).toBe("live launcher");
    }
    expect((await fs.readdir(root)).toSorted()).toEqual(["destination", "source"]);
  },
);

it("keeps the live launcher intact when its replacement copy is interrupted", async () => {
  const root = dirs.make("package-launcher-copy-");
  const source = path.join(root, "retained-launcher");
  const destination = path.join(root, "live-launcher");
  await fs.writeFile(source, "previous launcher\n");
  await fs.writeFile(destination, "candidate launcher\n");
  const prototype = Object.getPrototypeOf(await fsSafeRoot(root)) as Root;
  const copy = vi.spyOn(prototype, "copyIn").mockImplementationOnce(async function (
    this: Root,
    target,
  ) {
    await fs.writeFile(path.join(this.rootReal, target), "partial launcher");
    throw new Error("interrupted launcher copy");
  });

  await expect(copyPackagePathEntry(source, destination)).rejects.toThrow(
    "interrupted launcher copy",
  );
  expect(copy).toHaveBeenCalledOnce();
  expect(await fs.readFile(destination, "utf8")).toBe("candidate launcher\n");
  expect((await fs.readdir(root)).toSorted()).toEqual(["live-launcher", "retained-launcher"]);

  copy.mockRestore();
  await copyPackagePathEntry(source, destination);
  expect(await fs.readFile(destination, "utf8")).toBe("previous launcher\n");
});

it("stages a complete directory with independent hardlinked files and preserved modes", async () => {
  const root = dirs.make("package-launcher-tree-");
  const source = path.join(root, "source");
  const destination = path.join(root, "destination");
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
  expect(await fs.readFile(published, "utf8")).toBe("launcher bytes");
  expect((await fs.lstat(published, { bigint: true })).ino).not.toBe(
    (await fs.lstat(original, { bigint: true })).ino,
  );
  expect((await fs.stat(published)).mode).toBe((await fs.stat(original)).mode);
  expect((await fs.stat(path.join(destination, "nested"))).mode).toBe(
    (await fs.stat(path.join(source, "nested"))).mode,
  );
  expect((await fs.readdir(root)).toSorted()).toEqual([
    "destination",
    "retained-hardlink",
    "source",
  ]);
});

it.skipIf(process.platform === "win32")(
  "retains the directory-copy link contract without copying the linked target",
  async () => {
    const root = dirs.make("package-launcher-links-");
    const source = path.join(root, "source");
    const destination = path.join(root, "destination");
    await fs.mkdir(source);
    await fs.writeFile(path.join(root, "outside.txt"), "outside");
    await fs.symlink("../outside.txt", path.join(source, "link"));

    await copyPackagePathEntry(source, destination);

    expect(await fs.readlink(path.join(destination, "link"))).toBe(path.join(root, "outside.txt"));
    expect(await fs.readFile(path.join(root, "outside.txt"), "utf8")).toBe("outside");
  },
);

it("keeps the live tree intact and cleans private staging after copy authority closes", async () => {
  const root = dirs.make("package-launcher-copy-authority-");
  const source = path.join(root, "source");
  const destination = path.join(root, "destination");
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
  expect(await fs.readFile(path.join(destination, "live.txt"), "utf8")).toBe("live launcher");
  expect((await fs.readdir(root)).toSorted()).toEqual(["destination", "source"]);
});

it("retains the first copy failure when private staging has been replaced", async () => {
  const root = dirs.make("package-launcher-private-owner-");
  const source = path.join(root, "source");
  const destination = path.join(root, "destination");
  const retained = path.join(root, "retained-stage");
  await fs.writeFile(source, "replacement");
  await fs.writeFile(destination, "live");
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
  expect(await fs.readFile(destination, "utf8")).toBe("live");
  expect(await fs.readFile(path.join(replaced, "foreign.txt"), "utf8")).toBe("successor staging");
  expect(await fs.readFile(path.join(retained, "entry"), "utf8")).toBe("replacement");
});

it.each([
  { name: "ENOENT", refusal: Object.assign(new Error("owner missing"), { code: "ENOENT" }) },
  { name: "EBUSY", refusal: Object.assign(new Error("owner replaced"), { code: "EBUSY" }) },
  { name: "false", refusal: false },
])("does not retire a backup after a one-shot $name ownership refusal", async ({ refusal }) => {
  const root = dirs.make("package-backup-refusal-");
  const backup = path.join(root, ".openclaw.backup");
  await fs.mkdir(backup);
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
  if (outcome.ok) {
    throw new Error("backup retirement accepted a refused owner");
  }
  expect(outcome.error).toBe(refusal);
  expect(refusals).toBe(1);
  expect(await fs.readFile(path.join(backup, "b.txt"), "utf8")).toBe("retained");
  await expect(fs.lstat(path.join(backup, "a.txt"))).rejects.toHaveProperty("code", "ENOENT");
  await expect(fs.lstat(path.join(root, ".openclaw-backup"))).rejects.toHaveProperty(
    "code",
    "ENOENT",
  );
});

it("retains delayed retirement for an ordinary backup removal I/O failure", async () => {
  const root = dirs.make("package-backup-io-");
  const backup = path.join(root, ".openclaw.backup");
  await fs.mkdir(backup);
  await fs.writeFile(path.join(backup, "marker.txt"), "old");
  const prototype = Object.getPrototypeOf(await fsSafeRoot(root)) as Root;
  const remove = vi
    .spyOn(prototype, "remove")
    .mockRejectedValueOnce(Object.assign(new Error("cleanup I/O failure"), { code: "EIO" }));

  const warning = await discardPackageUpdateBackup(backup, "backup", root);

  expect(remove).toHaveBeenCalledOnce();
  expect(warning).toContain("for delayed cleanup");
  expect(await fs.readFile(path.join(root, ".openclaw-backup", "marker.txt"), "utf8")).toBe("old");
  await expect(fs.lstat(backup)).rejects.toHaveProperty("code", "ENOENT");
});

it.each(["backup", "parent"] as const)(
  "does not retire a replacement %s after the last owned rmdir fails",
  async (replacement) => {
    const sandbox = dirs.make("package-backup-replacement-");
    await fs.mkdir(path.join(sandbox, "global"));
    const root = await fs.realpath(path.join(sandbox, "global"));
    const backup = path.join(root, ".openclaw.backup");
    const retired = path.join(root, ".openclaw-backup");
    const retained = path.join(path.dirname(root), "retained");
    await fs.mkdir(backup);
    await fs.writeFile(path.join(backup, "old.txt"), "obsolete");
    const original = await fs.lstat(backup, { bigint: true });
    const rmdir = fs.rmdir.bind(fs);
    let injections = 0;
    vi.spyOn(fs, "rmdir").mockImplementation(async (...args) => {
      if (String(args[0]) === backup) {
        injections += 1;
        // The owned leaf was removed first. Race the final directory operation,
        // then return an ordinary errno that used to admit the rename fallback.
        expect(await fs.readdir(backup)).toEqual([]);
        await fs.rename(replacement === "backup" ? backup : root, retained);
        await fs.mkdir(backup, { recursive: true });
        await fs.writeFile(path.join(backup, "sentinel.txt"), "successor");
        throw Object.assign(new Error("final backup removal failed"), { code: "EIO" });
      }
      await rmdir(...args);
    });
    const rename = vi.spyOn(fs, "rename");

    await expect(discardPackageUpdateBackup(backup, "old package", root)).rejects.toHaveProperty(
      "code",
      "path-mismatch",
    );

    expect(injections).toBe(1);
    expect(rename.mock.calls.some(([, destination]) => String(destination) === retired)).toBe(
      false,
    );
    expect(await fs.readFile(path.join(backup, "sentinel.txt"), "utf8")).toBe("successor");
    const retainedBackup =
      replacement === "backup" ? retained : path.join(retained, path.basename(backup));
    expect(await fs.lstat(retainedBackup, { bigint: true })).toMatchObject({
      dev: original.dev,
      ino: original.ino,
    });
    expect(await fs.readdir(retainedBackup)).toEqual([]);
    await expect(fs.lstat(retired)).rejects.toHaveProperty("code", "ENOENT");
  },
);

it("does not compensate a root rename after its original owner refused once", async () => {
  const root = dirs.make("package-root-restore-owner-");
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
  await expect(fs.lstat(liveRoot)).rejects.toHaveProperty("code", "ENOENT");
  expect(await fs.readFile(path.join(displacedRoot, "marker.txt"), "utf8")).toBe("candidate");
  expect(await fs.readFile(path.join(backupRoot, "marker.txt"), "utf8")).toBe("original");
});

it.each([
  {
    name: "a false copy failure",
    copyFailure: { error: false },
    cleanupFailure: undefined,
  },
  {
    name: "an undefined copy failure before a cleanup failure",
    copyFailure: { error: undefined },
    cleanupFailure: { error: new Error("cleanup failed after copy refusal") },
  },
  {
    name: "a sole cleanup failure",
    copyFailure: undefined,
    cleanupFailure: { error: new Error("cleanup failed after publication") },
  },
  {
    name: "a sole undefined cleanup failure",
    copyFailure: undefined,
    cleanupFailure: { error: undefined },
  },
])("retains $name through private copy cleanup", async ({ copyFailure, cleanupFailure }) => {
  const root = await fs.realpath(dirs.make("package-copy-cleanup-result-"));
  const source = path.join(root, "source");
  const destination = path.join(root, "destination");
  await fs.writeFile(source, "replacement");
  await fs.writeFile(destination, "live");
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
      // oxlint-disable-next-line typescript/only-throw-error -- false and undefined must remain the original copy failure.
      throw copyFailure.error;
    }
    return copy.call(this, ...args);
  });
  vi.spyOn(prototype, "remove").mockImplementation(function (this: Root, relativePath, options) {
    if (path.basename(relativePath).startsWith(".openclaw-shim-stage-")) {
      cleanupAttempts += 1;
      if (cleanupFailure) {
        // oxlint-disable-next-line typescript/only-throw-error -- An undefined cleanup failure must remain a failure.
        throw cleanupFailure.error;
      }
    }
    return remove.call(this, relativePath, options);
  });
  const rename = vi.spyOn(fs, "rename");

  const outcome = await copyPackagePathEntry(source, destination).then(
    () => ({ ok: true as const }),
    (error: unknown) => ({ ok: false as const, error }),
  );

  expect(outcome.ok).toBe(false);
  if (outcome.ok) {
    throw new Error("copy cleanup silently accepted a failure");
  }
  expect(outcome.error).toBe((copyFailure ?? cleanupFailure)?.error);
  expect(copySpy).toHaveBeenCalledOnce();
  expect(cleanupAttempts).toBe(1);
  expect(staging).not.toBe("");
  expect(rename.mock.calls.filter(([, to]) => String(to) === destination)).toHaveLength(
    copyFailure ? 0 : 1,
  );
  expect(await fs.readFile(source, "utf8")).toBe("replacement");
  expect(await fs.readFile(destination, "utf8")).toBe(copyFailure ? "live" : "replacement");
  if (cleanupFailure) {
    expect(await fs.readdir(staging)).toEqual([]);
  } else {
    await expect(fs.lstat(staging)).rejects.toHaveProperty("code", "ENOENT");
  }
});
