import { spawnSync } from "node:child_process";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi, type Mock } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as pidAlive from "../shared/pid-alive.js";
import { createFileLockManager } from "./file-lock-manager.js";
import {
  completePendingPackageLifecycle,
  discardPendingPackageLifecycle,
  PackageLifecycleOwnershipError as OwnershipError,
  type PackageLifecycleScript,
} from "./package-lifecycle.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());
afterEach(() => vi.unstubAllEnvs());
type RunScript = (script: PackageLifecycleScript) => void | Promise<void>;
let packageRoot: string, pending: string, lock: string, legacy: string;
let runScript: Mock<RunScript>;
beforeEach(async () => {
  ({ packageRoot, pending, lock } = await fixture());
  legacy = path.join(packageRoot, "dist/openclaw-install-guard");
  runScript = vi.fn<RunScript>();
});
const finish = (script: RunScript = runScript, timeoutMs?: number) =>
  completePendingPackageLifecycle({ packageRoot, runScript: script, timeoutMs });
const dispose = (discard: () => Promise<void>, packageRoots = [packageRoot]) =>
  discardPendingPackageLifecycle({ packageRoots, discard });
const read = (file: string) => fs.readFile(file, "utf8");
const missing = (...files: string[]) =>
  Promise.all(
    files.map((file) => expect(fs.lstat(file)).rejects.toMatchObject({ code: "ENOENT" })),
  );
const uncertainty = (cause?: unknown) => ({
  name: "PackageLifecycleOwnershipError",
  packageRoot,
  lockPath: lock,
  ...(cause ? { cause } : {}),
});
const identity = (file: string) =>
  fs.stat(file, { bigint: true }).then(({ dev, ino }) => [dev, ino]);
const writeOwner = (overrides: object = {}) =>
  fs.writeFile(lock, JSON.stringify({ ...ownerPayload(), ...overrides }));
const displacedRoot = () => path.join(tempDirs.make("openclaw-lifecycle-displaced-"), "package");
const ioError = (message: string, code = "EACCES") => Object.assign(new Error(message), { code });
const releaseError = (cause: Error) => ({
  name: "PackageLifecycleOwnershipError",
  cause: { name: "FsSafeError", code: "not-removable", cause },
});
async function writeLegacy() {
  await fs.mkdir(path.dirname(legacy), { recursive: true });
  await fs.writeFile(legacy, "legacy pending\n");
}
function onPendingAccess(action: () => Promise<void>, { at = 1, after = true } = {}) {
  const access = fs.access;
  let reads = 0;
  vi.spyOn(fs, "access").mockImplementation(async (file, mode) => {
    const selected = file === pending && ++reads === at;
    if (selected && !after) {
      await action();
    }
    const result = await access(file, mode);
    if (selected && after) {
      await action();
    }
    return result;
  });
}
const settle = <T>(work: Promise<T>) =>
  work.then(
    (completed) => ({ completed }),
    (error: unknown) => ({ error }),
  );
function onLockOpen(action: (flags: Parameters<typeof fs.open>[1]) => Promise<void>) {
  const open = fs.open;
  vi.spyOn(fs, "open").mockImplementation(async (file, flags, mode) => {
    if (file === lock) {
      await action(flags);
    }
    return open(file, flags, mode);
  });
}
function onPendingWrite(action: () => Promise<void>) {
  const write = fs.writeFile;
  vi.spyOn(fs, "writeFile").mockImplementation(async (file, data, options) => {
    if (file === pending) {
      await action();
    }
    return write(file, data, options);
  });
}
async function optionalPending() {
  return read(pending).catch((error: unknown) => {
    expect(error).toMatchObject({ code: "ENOENT" });
    return null;
  });
}
function observeContention() {
  const contended = createDeferred();
  const isPidAlive = pidAlive.isPidAlive;
  vi.spyOn(pidAlive, "isPidAlive").mockImplementation((pid) => {
    contended.resolve();
    return isPidAlive(pid);
  });
  return contended.promise;
}
function denyRelease(denial: Error) {
  vi.stubEnv("FS_SAFE_NATIVE_MODE", "off");
  const unlink = fs.unlink;
  vi.spyOn(fs, "unlink").mockImplementation(async (file) => {
    if (file === lock) {
      throw denial;
    }
    return unlink(file);
  });
}

async function fixture() {
  const root = tempDirs.make("openclaw-lifecycle-ownership-");
  const marker = path.join(root, ".openclaw-lifecycle-pending");
  await fs.writeFile(marker, "pending\n");
  return { packageRoot: root, pending: marker, lock: path.join(root, ".openclaw-lifecycle-lock") };
}

function ownerPayload() {
  return {
    kind: "openclaw-package-lifecycle",
    version: 1,
    pid: process.pid,
    starttime: pidAlive.getFileLockProcessStartTime(process.pid),
  };
}

function isExclusiveCreate(flags: string | number | undefined): boolean {
  return (
    flags === "wx" ||
    (typeof flags === "number" &&
      (flags & fsSync.constants.O_CREAT) !== 0 &&
      (flags & fsSync.constants.O_EXCL) !== 0)
  );
}

it.each(["absent", "replacement-pending", "replacement-complete"])(
  "refuses %s root after observation-time disposal",
  async (state) => {
    const originalIdentity = await identity(packageRoot);
    // Allocate while the original exists: deletion may immediately recycle its inode.
    const replacementRoot = tempDirs.make("openclaw-lifecycle-replacement-");
    const replacementIdentity = await identity(replacementRoot);
    expect(replacementIdentity).not.toEqual(originalIdentity);
    let replaced = false;
    vi.stubEnv("FS_SAFE_NATIVE_MODE", "off");
    onPendingAccess(async () => {
      replaced = true;
      await dispose(() => fs.rm(packageRoot, { recursive: true, force: true }));
      await missing(packageRoot);
      if (state !== "absent") {
        await fs.rename(replacementRoot, packageRoot);
        expect(await identity(packageRoot)).toEqual(replacementIdentity);
        if (state === "replacement-pending") {
          await fs.writeFile(pending, "replacement pending\n");
        }
      }
    });
    await expect(finish()).rejects.toMatchObject({ name: "PackageLifecycleOwnershipError" });
    expect({ replaced, dispatches: runScript.mock.calls.length }).toEqual({
      replaced: true,
      dispatches: 0,
    });
    await missing(lock);
    if (state === "absent") {
      await missing(packageRoot);
    } else if (state === "replacement-pending") {
      expect(await read(pending)).toBe("replacement pending\n");
    }
  },
);

it.each(["absent", "replacement-empty", "replacement-pending"])(
  "does not arm %s root displaced during a script",
  async (state) => {
    const displaced = displacedRoot();
    const cooperativeDiscard = vi.fn();
    let originalLock: Buffer | undefined;
    vi.stubEnv("FS_SAFE_NATIVE_MODE", "off");
    runScript.mockImplementation(async () => {
      await expect(dispose(cooperativeDiscard)).rejects.toBeInstanceOf(OwnershipError);
      expect(cooperativeDiscard).not.toHaveBeenCalled();
      originalLock = await fs.readFile(lock);
      // This mutation deliberately bypasses the cooperative disposal lock.
      await fs.rename(packageRoot, displaced);
      if (state !== "absent") {
        await fs.mkdir(packageRoot);
        if (state === "replacement-pending") {
          await fs.writeFile(pending, "replacement pending\n");
        }
      }
    });
    await expect(finish()).rejects.toBeInstanceOf(OwnershipError);
    expect(runScript).toHaveBeenCalledTimes(1);
    expect(await fs.readFile(path.join(displaced, path.basename(lock)))).toEqual(originalLock);
    await missing(lock);
    if (state === "absent") {
      await missing(packageRoot);
      return;
    }
    const markerBeforeReplay = await optionalPending();
    if (state === "replacement-pending") {
      // The failed generation does not authorize recovery of its replacement.
      expect(markerBeforeReplay).toBe("replacement pending\n");
      return;
    }
    const replay = vi.fn();
    const completed = await finish(replay);
    expect({ markerBeforeReplay, completed, dispatches: replay.mock.calls.length }).toEqual({
      markerBeforeReplay: null,
      completed: false,
      dispatches: 0,
    });
  },
);

it.each([
  ["callback", "absent"],
  ["callback", "legacy"],
  ["release-before-retirement", "absent"],
  ["release-before-retirement", "pending"],
])("preserves retired work after %s failure (%s)", async (phase, shape) => {
  const other = await fixture();
  const failure = ioError("injected disposal failure");
  const rm = fs.rm;
  vi.stubEnv("FS_SAFE_NATIVE_MODE", "off");
  if (shape !== "pending") {
    await rm(pending);
  }
  if (shape === "legacy") {
    await writeLegacy();
  }
  const discard = vi.fn(async () => {
    await missing(pending, legacy);
    throw failure;
  });
  if (phase === "release-before-retirement") {
    await fs.writeFile(other.lock, "{unresolved");
    vi.spyOn(fs, "rm").mockImplementation(async (file, options) => {
      if (file === lock) {
        throw failure;
      }
      return rm(file, options);
    });
  }
  const disposal = dispose(
    discard,
    phase === "callback" ? [packageRoot] : [packageRoot, other.packageRoot],
  );
  if (phase === "callback") {
    await expect(disposal).rejects.toBe(failure);
    expect(discard).toHaveBeenCalledTimes(1);
  } else {
    await expect(disposal).rejects.toMatchObject({
      name: "PackageLifecycleOwnershipError",
      cause: failure,
    });
    expect(discard).not.toHaveBeenCalled();
    expect(await read(other.lock)).toBe("{unresolved");
  }
  vi.restoreAllMocks();
  if (phase === "release-before-retirement") {
    // Sidecar removal cannot settle the SDK's retained generation.
    const held = createFileLockManager("openclaw.package-lifecycle")
      .heldEntries()
      .find((entry) => entry.lockPath === lock);
    if (!held) {
      throw new Error("expected the failed release to retain its fixture lock");
    }
    await expect(held.forceRelease()).resolves.toBe(true);
  }
  await missing(lock);
  const markerBeforeReplay = await optionalPending();
  const replay = vi.fn(async () => {
    await rm(legacy, { force: true });
  });
  const completed = await finish(replay);
  const shouldRestore = phase === "callback" && shape !== "absent";
  expect({ markerBeforeReplay, completed, dispatches: replay.mock.calls.length }).toEqual({
    markerBeforeReplay: shape === "pending" || shouldRestore ? "pending\n" : null,
    completed: shape !== "absent",
    dispatches: shape !== "absent" ? 2 : 0,
  });
});
it.each([
  "directory",
  "partial",
  "unknown",
  "oversized",
  "reused-pid",
  "dead-parent",
  "symlink",
  "marker-absent",
])("refuses %s ownership without mutation or scripts", async (kind) => {
  const outside = path.join(packageRoot, "sentinel");
  if (kind === "marker-absent") {
    await fs.rm(pending);
  }
  if (kind === "directory") {
    await fs.mkdir(lock);
  } else if (kind === "symlink") {
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, "keep"), "keep");
    await fs.symlink(outside, lock, process.platform === "win32" ? "junction" : "dir");
  } else if (kind === "dead-parent") {
    const child = spawnSync(process.execPath, ["-e", ""], { timeout: 5000 });
    expect(child.status).toBe(0);
    await writeOwner({ pid: child.pid });
  } else {
    const raw =
      kind === "partial" || kind === "marker-absent"
        ? "{unfinished"
        : kind === "oversized"
          ? "x".repeat(1024 * 1024 + 1)
          : kind === "reused-pid"
            ? JSON.stringify({
                ...ownerPayload(),
                starttime: (pidAlive.getFileLockProcessStartTime(process.pid) ?? 0) + 1,
              })
            : "{}";
    await fs.writeFile(lock, raw);
  }
  const before = await fs.lstat(lock);
  const rawBefore = before.isFile() ? await fs.readFile(lock) : null;
  const completion = finish();
  await expect(completion).rejects.toMatchObject(uncertainty());
  if (kind === "dead-parent") {
    await expect(completion).rejects.toThrow("owner cannot be verified");
  }
  if (kind === "symlink") {
    await expect(completion).rejects.toBeInstanceOf(OwnershipError);
    expect((await fs.lstat(lock)).isSymbolicLink()).toBe(true);
    expect(await read(path.join(outside, "keep"))).toBe("keep");
  }
  expect(runScript).not.toHaveBeenCalled();
  expect((await fs.lstat(lock)).ino).toBe(before.ino);
  if (rawBefore) {
    expect(await fs.readFile(lock)).toEqual(rawBefore);
  }
  if (kind === "marker-absent") {
    await expect(completion).rejects.toBeInstanceOf(OwnershipError);
    await missing(pending);
  } else {
    expect(await read(pending)).toBe("pending\n");
  }
});

it("retries when the observed owner released before exiting", async () => {
  await writeOwner();
  vi.spyOn(pidAlive, "isPidAlive").mockImplementationOnce(() => {
    fsSync.rmSync(lock);
    return false;
  });
  await expect(finish()).resolves.toBe(true);
  expect(runScript).toHaveBeenCalledTimes(2);
  await missing(lock);
});

it.each(["not-directory", "inaccessible", "removed-on-create"])(
  "refuses %s roots",
  async (state) => {
    const displaced = displacedRoot();
    const canonicalRoot = fsSync.realpathSync(packageRoot);
    const denial = ioError("root permission denied");
    let observed = false;
    vi.stubEnv("FS_SAFE_NATIVE_MODE", "off");
    if (state === "removed-on-create") {
      onLockOpen(async (flags) => {
        if (isExclusiveCreate(flags)) {
          observed = true;
          await fs.rm(packageRoot, { recursive: true, force: true });
        }
      });
    } else {
      const lstatSync = fsSync.lstatSync;
      vi.spyOn(fsSync, "lstatSync").mockImplementation((file, options) => {
        if (observed && state === "inaccessible" && file === canonicalRoot) {
          throw denial;
        }
        return lstatSync(file, options);
      });
      onPendingAccess(async () => {
        observed = true;
        if (state === "not-directory") {
          await fs.rename(packageRoot, displaced);
          await fs.writeFile(packageRoot, "replacement file\n");
        }
      });
    }
    await expect(finish()).rejects.toMatchObject(uncertainty({ code: "path-mismatch" }));
    expect(observed).toBe(true);
    expect(runScript).not.toHaveBeenCalled();
    if (state === "not-directory") {
      expect(await read(packageRoot)).toBe("replacement file\n");
      expect(await read(path.join(displaced, path.basename(pending)))).toBe("pending\n");
    } else if (state === "inaccessible") {
      expect(await read(pending)).toBe("pending\n");
      await missing(lock);
    } else {
      await missing(packageRoot);
    }
  },
);

it.each(["pending", "completed", "replacement"])("reads %s after release", async (state) => {
  vi.stubEnv("FS_SAFE_NATIVE_MODE", "off");
  await writeOwner();
  let released = false;
  onLockOpen(async (flags) => {
    if (
      !released &&
      typeof flags === "number" &&
      (flags & (fsSync.constants.O_WRONLY | fsSync.constants.O_RDWR)) === 0
    ) {
      released = true;
      // Root.create may reject before open; release only on the contended read.
      await fs.rm(lock);
      if (state === "completed") {
        await fs.rm(pending);
      } else if (state === "replacement") {
        await fs.writeFile(lock, "{replacement publishing");
      }
    }
  });
  const completion = finish();
  if (state === "replacement") {
    await expect(completion).rejects.toBeInstanceOf(OwnershipError);
    expect(runScript).not.toHaveBeenCalled();
    expect(await read(lock)).toBe("{replacement publishing");
    expect(await read(pending)).toBe("pending\n");
  } else {
    await expect(completion).resolves.toBe(state === "pending");
    expect(runScript).toHaveBeenCalledTimes(state === "pending" ? 2 : 0);
    await missing(lock, pending);
  }
  expect(released).toBe(true);
});

it("bounds admission with monotonic time", async () => {
  await writeOwner();
  let monotonicNow = 0;
  const clock = vi.spyOn(performance, "now").mockImplementation(() => monotonicNow);
  const waiting = finish(runScript, 1);
  const refused = expect(waiting).rejects.toThrow("admission wait expired");
  try {
    await vi.waitFor(() => expect(clock.mock.calls.length).toBeGreaterThanOrEqual(3));
    // Neither a backward wall-clock jump nor refreshed metadata extends admission.
    vi.spyOn(Date, "now").mockReturnValue(0);
    await writeOwner({ updatedAt: 9e15 });
    monotonicNow = 20 * 60_000 + 3;
    await refused;
    expect(runScript).not.toHaveBeenCalled();
    await fs.access(lock);
  } finally {
    monotonicNow = Number.MAX_SAFE_INTEGER;
    await Promise.allSettled([waiting]);
  }
});

it.each(["promotion", "script"] as const)("refuses %s lock replacement", async (phase) => {
  const replace = async () => {
    await fs.rename(lock, path.join(packageRoot, "original-generation"));
    await fs.writeFile(lock, "replacement generation\n");
  };
  if (phase === "promotion") {
    const writeFile = fs.writeFile;
    onPendingWrite(async () => {
      await replace();
      vi.mocked(fs.writeFile).mockImplementation(writeFile);
    });
  }
  runScript.mockImplementation(replace);
  await expect(finish()).rejects.toBeInstanceOf(OwnershipError);
  expect(runScript).toHaveBeenCalledTimes(phase === "script" ? 1 : 0);
  expect(await read(lock)).toBe("replacement generation\n");
  expect(await read(pending)).toBe("pending\n");
});

it.each(["ownership", "release"])("keeps work retired after %s failure", async (failure) => {
  const rm = fs.rm;
  const denial = ioError("release denied");
  let retainedLock = "";
  onPendingAccess(
    async () => {
      // Dispose after observation, before the admitted generation's pending check.
      await rm(pending);
      if (failure === "ownership") {
        await fs.rename(lock, path.join(packageRoot, "original-generation"));
        await fs.writeFile(lock, "replacement");
      }
      retainedLock = await read(lock);
    },
    { at: 2, after: false },
  );
  if (failure === "release") {
    denyRelease(denial);
  }
  const completion = finish();
  if (failure === "ownership") {
    await expect(completion).rejects.toBeInstanceOf(OwnershipError);
  } else {
    await expect(completion).rejects.toMatchObject(releaseError(denial));
  }
  expect(runScript).not.toHaveBeenCalled();
  expect(retainedLock).not.toBe("");
  expect(await read(lock)).toBe(retainedLock);
  await missing(pending);

  vi.restoreAllMocks();
  await rm(lock);
  await expect(finish()).resolves.toBe(false);
  expect(runScript).not.toHaveBeenCalled();
});

it.each(["publication", "create", "read", "dispose"] as const)(
  "preserves %s acquisition errors",
  async (phase) => {
    vi.stubEnv("FS_SAFE_NATIVE_MODE", "off");
    if (phase === "read") {
      await fs.writeFile(lock, "{}");
    }
    const failure = ioError(`${phase} failed`, phase === "publication" ? "EIO" : "EACCES");
    const open = fs.open;
    vi.spyOn(fs, "open").mockImplementation(async (file, flags, mode) => {
      const targeted =
        file === lock &&
        (phase === "read"
          ? typeof flags === "number" && !isExclusiveCreate(flags)
          : isExclusiveCreate(flags));
      if (targeted && phase !== "publication") {
        throw failure;
      }
      const handle = await open(file, flags, mode);
      if (targeted) {
        const write = handle.write.bind(handle);
        vi.spyOn(handle, "write").mockImplementation(async () => {
          await write(Buffer.from("{partial"));
          throw failure;
        });
      }
      return handle;
    });
    const dispatch = vi.fn(async () => {});
    const completion = phase === "dispose" ? dispose(dispatch) : finish(dispatch);
    if (phase === "dispose") {
      await expect(completion).rejects.toBe(failure);
      expect(await read(pending)).toBe("pending\n");
    } else {
      await expect(completion).rejects.toMatchObject(
        phase === "read"
          ? { name: "PackageLifecycleOwnershipError", cause: failure, lockPath: lock }
          : { name: "FsSafeError", code: "invalid-path", cause: failure },
      );
    }
    expect(dispatch).not.toHaveBeenCalled();
    if (phase === "read") {
      expect(await read(lock)).toBe("{}");
    } else {
      await missing(lock);
    }
  },
);

it.each(["pending", "legacy"])("retires %s before disposal waiters enter", async (shape) => {
  await writeLegacy();
  if (shape === "legacy") {
    await fs.rm(pending);
  }
  const contended = observeContention();
  const rm = fs.rm;
  let contender: Promise<{ completed: boolean } | { error: unknown }> | undefined;
  vi.spyOn(fs, "rm").mockImplementation(async (file, options) => {
    if (file === (shape === "legacy" ? legacy : pending) && !contender) {
      contender = settle(finish());
      await contended;
    }
    return rm(file, options);
  });
  try {
    await dispose(async () => {
      await expect(fs.access(pending)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.access(legacy)).rejects.toMatchObject({ code: "ENOENT" });
      // A recursive remover may unlink the in-tree lock before other files.
      await rm(lock, { force: true });
      expect(runScript).not.toHaveBeenCalled();
      await rm(packageRoot, { recursive: true, force: true });
    });
    // Release must not depend on this same-process waiter's settlement.
    const result = await contender;
    expect(result).toBeDefined();
    if (result && "error" in result) {
      expect(result.error).toBeInstanceOf(OwnershipError);
    } else {
      expect(result).toEqual({ completed: false });
    }
    expect(runScript).not.toHaveBeenCalled();
    await expect(fs.access(packageRoot)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    vi.restoreAllMocks();
    await rm(lock, { force: true });
    await contender;
  }
});

it.each(["removed", "replacement"])("refuses %s roots after disposal", async (state) => {
  const displaced = displacedRoot();
  const contended = observeContention();
  let completion: ReturnType<typeof settle<boolean>> | undefined;
  vi.stubEnv("FS_SAFE_NATIVE_MODE", "off");
  vi.useFakeTimers({ toFake: ["setTimeout"] });
  try {
    await dispose(async () => {
      completion = settle(finish());
      await Promise.race([
        contended,
        completion.then(() => {
          throw new Error("expected lifecycle admission to wait for the disposal owner");
        }),
      ]);
      // Control only retry time, not provider/filesystem operations.
      if (state === "removed") {
        await fs.rm(packageRoot, { recursive: true, force: true });
      } else {
        await fs.rename(packageRoot, displaced);
        await fs.mkdir(packageRoot);
        await fs.writeFile(pending, "replacement pending\n");
      }
      await vi.advanceTimersByTimeAsync(100);
      await completion;
    });
    if (state === "removed") {
      await missing(packageRoot);
    } else {
      expect(await read(pending)).toBe("replacement pending\n");
      await missing(lock);
    }
    expect(runScript).not.toHaveBeenCalled();
    expect(await completion).toMatchObject({
      error: uncertainty({ code: "path-mismatch" }),
    });
  } finally {
    vi.useRealTimers();
    await completion;
  }
});

it("preserves pending evidence after release failure", async () => {
  const denial = ioError("release denied");
  denyRelease(denial);
  await expect(finish()).rejects.toMatchObject(releaseError(denial));
  expect(runScript).toHaveBeenCalledTimes(2);
  expect(await read(pending)).toBe("pending\n");
  await fs.access(lock);
});

it("preserves script failure identity after restoration failure", async () => {
  const scriptFailure = new Error("script settled unsuccessfully");
  const restorationFailure = ioError("marker restoration failed", "EIO");
  let scriptSettled = false;
  let failedRestorations = 0;
  vi.stubEnv("FS_SAFE_NATIVE_MODE", "off");
  onPendingWrite(async () => {
    if (scriptSettled) {
      failedRestorations += 1;
      throw restorationFailure;
    }
  });
  runScript.mockImplementation(async () => {
    await fs.rm(pending);
    scriptSettled = true;
    throw scriptFailure;
  });
  await expect(finish()).rejects.toBe(scriptFailure);
  expect(scriptSettled).toBe(true);
  expect(failedRestorations).toBe(1);
  expect(runScript).toHaveBeenCalledTimes(1);
  await missing(lock, pending);
});
