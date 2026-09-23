import { spawnSync } from "node:child_process";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as pidAlive from "../shared/pid-alive.js";
import { createFileLockManager } from "./file-lock-manager.js";
import {
  completePendingPackageLifecycle,
  discardPendingPackageLifecycle,
  PackageLifecycleOwnershipError,
} from "./package-lifecycle.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());
afterEach(() => vi.unstubAllEnvs());

async function fixture() {
  const packageRoot = tempDirs.make("openclaw-lifecycle-ownership-");
  const pending = path.join(packageRoot, ".openclaw-lifecycle-pending");
  const lock = path.join(packageRoot, ".openclaw-lifecycle-lock");
  await fs.writeFile(pending, "pending\n");
  return { packageRoot, pending, lock };
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

describe("package lifecycle ownership", () => {
  describe("directory identity and disposal recovery", () => {
    it.each(["absent", "replacement-pending", "replacement-complete"])(
      "refuses %s after cooperative disposal between observation and admission",
      async (state) => {
        const { packageRoot, pending, lock } = await fixture();
        const originalIdentity = await fs.stat(packageRoot, { bigint: true });
        // Allocate while the original exists: deletion may immediately recycle its inode.
        const replacementRoot = tempDirs.make("openclaw-lifecycle-replacement-");
        const replacementIdentity = await fs.stat(replacementRoot, { bigint: true });
        expect([replacementIdentity.dev, replacementIdentity.ino]).not.toEqual([
          originalIdentity.dev,
          originalIdentity.ino,
        ]);
        const access = fs.access;
        let replaced = false;
        vi.stubEnv("FS_SAFE_NATIVE_MODE", "off");
        vi.spyOn(fs, "access").mockImplementation(async (file, mode) => {
          const result = await access(file, mode);
          if (file === pending && !replaced) {
            replaced = true;
            await discardPendingPackageLifecycle({
              packageRoots: [packageRoot],
              discard: () => fs.rm(packageRoot, { recursive: true, force: true }),
            });
            await expect(fs.lstat(packageRoot)).rejects.toMatchObject({ code: "ENOENT" });
            if (state !== "absent") {
              await fs.rename(replacementRoot, packageRoot);
              const installedIdentity = await fs.stat(packageRoot, { bigint: true });
              expect([installedIdentity.dev, installedIdentity.ino]).toEqual([
                replacementIdentity.dev,
                replacementIdentity.ino,
              ]);
              if (state === "replacement-pending") {
                await fs.writeFile(pending, "replacement pending\n");
              }
            }
          }
          return result;
        });
        const runScript = vi.fn();
        const outcome = await completePendingPackageLifecycle({ packageRoot, runScript }).then(
          (completed) => ({ completed }),
          (error: unknown) => ({ error }),
        );
        expect(replaced).toBe(true);
        await expect(fs.lstat(lock)).rejects.toMatchObject({ code: "ENOENT" });
        expect({ outcome, dispatches: runScript.mock.calls.length }).toMatchObject({
          outcome: { error: { name: "PackageLifecycleOwnershipError" } },
          dispatches: 0,
        });
        if (state === "absent") {
          await expect(fs.lstat(packageRoot)).rejects.toMatchObject({ code: "ENOENT" });
        } else if (state === "replacement-pending") {
          expect(await fs.readFile(pending, "utf8")).toBe("replacement pending\n");
        }
      },
    );

    it.each(["absent", "replacement-empty", "replacement-pending"])(
      "does not arm %s after an outside root mutation during its script",
      async (state) => {
        const { packageRoot, pending, lock } = await fixture();
        const displacedRoot = path.join(tempDirs.make("openclaw-v13-displaced-"), "package");
        const cooperativeDiscard = vi.fn();
        let originalLock: Buffer | undefined;
        vi.stubEnv("FS_SAFE_NATIVE_MODE", "off");
        const runScript = vi.fn(async () => {
          await expect(
            discardPendingPackageLifecycle({
              packageRoots: [packageRoot],
              discard: cooperativeDiscard,
            }),
          ).rejects.toBeInstanceOf(PackageLifecycleOwnershipError);
          expect(cooperativeDiscard).not.toHaveBeenCalled();
          originalLock = await fs.readFile(lock);
          // This mutation deliberately bypasses the cooperative disposal lock.
          await fs.rename(packageRoot, displacedRoot);
          if (state !== "absent") {
            await fs.mkdir(packageRoot);
            if (state === "replacement-pending") {
              await fs.writeFile(pending, "replacement pending\n");
            }
          }
        });
        await expect(
          completePendingPackageLifecycle({ packageRoot, runScript }),
        ).rejects.toBeInstanceOf(PackageLifecycleOwnershipError);
        expect(runScript).toHaveBeenCalledTimes(1);
        expect(await fs.readFile(path.join(displacedRoot, path.basename(lock)))).toEqual(
          originalLock,
        );
        await expect(fs.lstat(lock)).rejects.toMatchObject({ code: "ENOENT" });
        if (state === "absent") {
          // Direct marker restoration does not recursively create its parent.
          await expect(fs.lstat(packageRoot)).rejects.toMatchObject({ code: "ENOENT" });
          return;
        }
        const markerBeforeReplay = await fs.readFile(pending, "utf8").catch((error: unknown) => {
          expect(error).toMatchObject({ code: "ENOENT" });
          return null;
        });
        if (state === "replacement-pending") {
          // Losing the original directory does not authorize recovery of its
          // replacement through this process's failed-release bookkeeping.
          expect(markerBeforeReplay).toBe("replacement pending\n");
          return;
        }
        const replay = vi.fn();
        const completed = await completePendingPackageLifecycle({ packageRoot, runScript: replay });
        expect({ markerBeforeReplay, completed, dispatches: replay.mock.calls.length }).toEqual({
          markerBeforeReplay: null,
          completed: false,
          dispatches: 0,
        });
      },
    );

    it.each([
      ["callback", "absent"],
      ["callback", "pending"],
      ["callback", "legacy"],
      ["release-before-retirement", "absent"],
      ["release-before-retirement", "pending"],
      ["release-before-retirement", "legacy"],
    ])("does not synthesize work after %s failure with %s markers", async (phase, shape) => {
      const { packageRoot, pending, lock } = await fixture();
      const other = await fixture();
      const legacy = path.join(packageRoot, "dist/openclaw-install-guard");
      const failure = Object.assign(new Error("injected disposal failure"), { code: "EACCES" });
      const rm = fs.rm;
      vi.stubEnv("FS_SAFE_NATIVE_MODE", "off");
      if (shape !== "pending") {
        await rm(pending);
      }
      if (shape === "legacy") {
        await fs.mkdir(path.dirname(legacy), { recursive: true });
        await fs.writeFile(legacy, "legacy pending\n");
      }
      const discard = vi.fn(async () => {
        await expect(fs.lstat(pending)).rejects.toMatchObject({ code: "ENOENT" });
        await expect(fs.lstat(legacy)).rejects.toMatchObject({ code: "ENOENT" });
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
      const disposal = discardPendingPackageLifecycle({
        packageRoots: phase === "callback" ? [packageRoot] : [packageRoot, other.packageRoot],
        discard,
      });
      if (phase === "callback") {
        await expect(disposal).rejects.toBe(failure);
        expect(discard).toHaveBeenCalledTimes(1);
      } else {
        await expect(disposal).rejects.toMatchObject({
          name: "PackageLifecycleOwnershipError",
          cause: failure,
        });
        expect(discard).not.toHaveBeenCalled();
        expect(await fs.readFile(other.lock, "utf8")).toBe("{unresolved");
      }
      vi.restoreAllMocks();
      if (phase === "release-before-retirement") {
        // No script was admitted and the injected denial has ended. Retry this
        // exact held generation; unlinking its sidecar does not settle the SDK entry.
        const held = createFileLockManager("openclaw.package-lifecycle")
          .heldEntries()
          .find((entry) => entry.lockPath === lock);
        if (!held) {
          throw new Error("expected the failed release to retain its fixture lock");
        }
        await expect(held.forceRelease()).resolves.toBe(true);
      }
      await expect(fs.lstat(lock)).rejects.toMatchObject({ code: "ENOENT" });
      const markerBeforeReplay = await fs.readFile(pending, "utf8").catch((error: unknown) => {
        expect(error).toMatchObject({ code: "ENOENT" });
        return null;
      });
      const replay = vi.fn(async () => {
        await rm(legacy, { force: true });
      });
      const completed = await completePendingPackageLifecycle({ packageRoot, runScript: replay });
      const shouldRestore = phase === "callback" && shape !== "absent";
      expect({ markerBeforeReplay, completed, dispatches: replay.mock.calls.length }).toEqual({
        markerBeforeReplay: shape === "pending" || shouldRestore ? "pending\n" : null,
        completed: shape !== "absent",
        dispatches: shape !== "absent" ? 2 : 0,
      });
    });
  });

  it.each(["directory", "empty", "partial", "unknown", "oversized", "reused-pid"])(
    "refuses %s ownership immediately without changing it or running scripts",
    async (kind) => {
      const { packageRoot, pending, lock } = await fixture();
      if (kind === "directory") {
        await fs.mkdir(lock);
      } else {
        const raw =
          kind === "empty"
            ? ""
            : kind === "partial"
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
      const runScript = vi.fn();
      await expect(
        completePendingPackageLifecycle({ packageRoot, runScript }),
      ).rejects.toMatchObject({
        name: "PackageLifecycleOwnershipError",
        packageRoot,
        lockPath: lock,
      });
      expect(runScript).not.toHaveBeenCalled();
      expect((await fs.lstat(lock)).ino).toBe(before.ino);
      if (rawBefore) {
        expect(await fs.readFile(lock)).toEqual(rawBefore);
      }
      expect(await fs.readFile(pending, "utf8")).toBe("pending\n");
    },
  );

  it("refuses a symlink lock without touching its target", async () => {
    const { packageRoot, lock } = await fixture();
    const outside = path.join(packageRoot, "sentinel");
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, "keep"), "keep");
    await fs.symlink(outside, lock, process.platform === "win32" ? "junction" : "dir");
    await expect(
      completePendingPackageLifecycle({ packageRoot, runScript: vi.fn() }),
    ).rejects.toBeInstanceOf(PackageLifecycleOwnershipError);
    expect((await fs.lstat(lock)).isSymbolicLink()).toBe(true);
    expect(await fs.readFile(path.join(outside, "keep"), "utf8")).toBe("keep");
  });

  it("never reclaims a dead parent's ownership record", async () => {
    const { packageRoot, lock } = await fixture();
    const child = spawnSync(process.execPath, ["-e", ""], { timeout: 5000 });
    expect(child.status).toBe(0);
    const raw = JSON.stringify({ ...ownerPayload(), pid: child.pid });
    await fs.writeFile(lock, raw);
    const runScript = vi.fn();
    await expect(completePendingPackageLifecycle({ packageRoot, runScript })).rejects.toThrow(
      "owner cannot be verified",
    );
    expect(runScript).not.toHaveBeenCalled();
    expect(await fs.readFile(lock, "utf8")).toBe(raw);
  });

  it("retries exclusive acquisition when the observed owner released before exiting", async () => {
    const { packageRoot, lock } = await fixture();
    await fs.writeFile(lock, JSON.stringify(ownerPayload()));
    vi.spyOn(pidAlive, "isPidAlive").mockImplementationOnce(() => {
      // The owner cooperatively removed its lock after our contended snapshot.
      fsSync.rmSync(lock);
      return false;
    });
    const runScript = vi.fn();
    await expect(completePendingPackageLifecycle({ packageRoot, runScript })).resolves.toBe(true);
    expect(runScript).toHaveBeenCalledTimes(2);
    await expect(fs.lstat(lock)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("returns without creating a lock for an already completed package", async () => {
    const { packageRoot, pending } = await fixture();
    await fs.rm(pending);
    const runScript = vi.fn();
    await expect(completePendingPackageLifecycle({ packageRoot, runScript })).resolves.toBe(false);
    expect(runScript).not.toHaveBeenCalled();
    expect(await fs.readdir(packageRoot)).toEqual([]);
  });

  it.each(["missing", "not-directory", "inaccessible"])(
    "preserves uncertainty when its bound package root becomes %s after observing work",
    async (state) => {
      const { packageRoot, pending, lock } = await fixture();
      const displacedRoot = path.join(tempDirs.make("openclaw-lifecycle-displaced-"), "package");
      const canonicalRoot = fsSync.realpathSync(packageRoot);
      const denial = Object.assign(new Error("root permission denied"), { code: "EACCES" });
      const access = fs.access;
      const lstatSync = fsSync.lstatSync;
      let observed = false;
      vi.stubEnv("FS_SAFE_NATIVE_MODE", "off");
      vi.spyOn(fsSync, "lstatSync").mockImplementation((file, options) => {
        if (observed && state === "inaccessible" && file === canonicalRoot) {
          throw denial;
        }
        return lstatSync(file, options);
      });
      vi.spyOn(fs, "access").mockImplementation(async (file, mode) => {
        const result = await access(file, mode);
        if (file === pending && !observed) {
          observed = true;
          if (state === "missing") {
            await fs.rm(packageRoot, { recursive: true, force: true });
          } else if (state === "not-directory") {
            await fs.rename(packageRoot, displacedRoot);
            await fs.writeFile(packageRoot, "replacement file\n");
          }
        }
        return result;
      });
      const runScript = vi.fn();
      await expect(
        completePendingPackageLifecycle({ packageRoot, runScript }),
      ).rejects.toMatchObject({
        name: "PackageLifecycleOwnershipError",
        packageRoot,
        lockPath: lock,
        cause: { code: "path-mismatch" },
      });
      expect(observed).toBe(true);
      expect(runScript).not.toHaveBeenCalled();
      if (state === "missing") {
        await expect(fs.lstat(packageRoot)).rejects.toMatchObject({ code: "ENOENT" });
      } else if (state === "not-directory") {
        expect(await fs.readFile(packageRoot, "utf8")).toBe("replacement file\n");
        expect(await fs.readFile(path.join(displacedRoot, path.basename(pending)), "utf8")).toBe(
          "pending\n",
        );
      } else {
        expect(await fs.readFile(pending, "utf8")).toBe("pending\n");
        await expect(fs.lstat(lock)).rejects.toMatchObject({ code: "ENOENT" });
      }
    },
  );

  it("preserves uncertainty when its root disappears during exclusive creation", async () => {
    const { packageRoot, lock } = await fixture();
    const open = fs.open;
    let removed = false;
    vi.stubEnv("FS_SAFE_NATIVE_MODE", "off");
    vi.spyOn(fs, "open").mockImplementation(async (file, flags, mode) => {
      if (file === lock && isExclusiveCreate(flags)) {
        removed = true;
        await fs.rm(packageRoot, { recursive: true, force: true });
      }
      return open(file, flags, mode);
    });
    const runScript = vi.fn();
    await expect(completePendingPackageLifecycle({ packageRoot, runScript })).rejects.toMatchObject(
      {
        name: "PackageLifecycleOwnershipError",
        packageRoot,
        lockPath: lock,
        cause: { code: "path-mismatch" },
      },
    );
    expect(removed).toBe(true);
    expect(runScript).not.toHaveBeenCalled();
    await expect(fs.lstat(packageRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["pending", "completed", "replacement"])(
    "handles a cooperative release before the contended read with %s work",
    async (state) => {
      const { packageRoot, pending, lock } = await fixture();
      vi.stubEnv("FS_SAFE_NATIVE_MODE", "off");
      await fs.writeFile(lock, JSON.stringify(ownerPayload()));
      const open = fs.open;
      let released = false;
      vi.spyOn(fs, "open").mockImplementation(async (file, flags, mode) => {
        if (
          !released &&
          file === lock &&
          typeof flags === "number" &&
          (flags & (fsSync.constants.O_WRONLY | fsSync.constants.O_RDWR)) === 0
        ) {
          released = true;
          // Root.create can reject an existing record before exclusive open.
          // Release after contention, before Root.open reads the owner's payload.
          await fs.rm(lock);
          if (state === "completed") {
            await fs.rm(pending);
          } else if (state === "replacement") {
            await fs.writeFile(lock, "{replacement publishing");
          }
        }
        return open(file, flags, mode);
      });
      const runScript = vi.fn();
      const completion = completePendingPackageLifecycle({ packageRoot, runScript });
      if (state === "replacement") {
        await expect(completion).rejects.toBeInstanceOf(PackageLifecycleOwnershipError);
        expect(runScript).not.toHaveBeenCalled();
        expect(await fs.readFile(lock, "utf8")).toBe("{replacement publishing");
        expect(await fs.readFile(pending, "utf8")).toBe("pending\n");
      } else {
        await expect(completion).resolves.toBe(state === "pending");
        expect(runScript).toHaveBeenCalledTimes(state === "pending" ? 2 : 0);
        await expect(fs.lstat(lock)).rejects.toMatchObject({ code: "ENOENT" });
        await expect(fs.lstat(pending)).rejects.toMatchObject({ code: "ENOENT" });
      }
      expect(released).toBe(true);
    },
  );

  it("refuses an ambiguous lock even after its pending marker disappears", async () => {
    const { packageRoot, lock, pending } = await fixture();
    await fs.rm(pending);
    await fs.writeFile(lock, "{partial");
    const runScript = vi.fn();
    await expect(
      completePendingPackageLifecycle({ packageRoot, runScript }),
    ).rejects.toBeInstanceOf(PackageLifecycleOwnershipError);
    expect(runScript).not.toHaveBeenCalled();
    expect(await fs.readFile(lock, "utf8")).toBe("{partial");
  });

  it("bounds a recognizable owner's admission wait with monotonic time", async () => {
    const { packageRoot, lock } = await fixture();
    await fs.writeFile(lock, JSON.stringify(ownerPayload()));
    let monotonicNow = 0;
    const clock = vi.spyOn(performance, "now").mockImplementation(() => monotonicNow);
    const runScript = vi.fn();
    const waiting = completePendingPackageLifecycle({ packageRoot, runScript, timeoutMs: 1 });
    const refused = expect(waiting).rejects.toThrow("admission wait expired");
    try {
      await vi.waitFor(() => expect(clock.mock.calls.length).toBeGreaterThanOrEqual(3));
      // Neither a backward wall-clock jump nor refreshed metadata extends admission.
      vi.spyOn(Date, "now").mockReturnValue(0);
      await fs.writeFile(lock, JSON.stringify({ ...ownerPayload(), updatedAt: 9e15 }));
      monotonicNow = 20 * 60_000 + 3;
      await refused;
      expect(runScript).not.toHaveBeenCalled();
      await expect(fs.access(lock)).resolves.toBeUndefined();
    } finally {
      monotonicNow = Number.MAX_SAFE_INTEGER;
      await Promise.allSettled([waiting]);
    }
  });

  it("preserves a replacement and refuses further dispatch by its former owner", async () => {
    const { packageRoot, pending, lock } = await fixture();
    let replacement: Buffer | undefined;
    const runScript = vi.fn(async () => {
      await fs.rename(lock, path.join(packageRoot, "original-generation"));
      replacement = Buffer.from("replacement generation\n");
      await fs.writeFile(lock, replacement);
    });
    await expect(completePendingPackageLifecycle({ packageRoot, runScript })).rejects.toThrow(
      "lock generation changed",
    );
    expect(runScript).toHaveBeenCalledTimes(1);
    expect(await fs.readFile(lock)).toEqual(replacement);
    expect(await fs.readFile(pending, "utf8")).toBe("pending\n");
  });

  it.each(["ownership", "release"])(
    "does not restore work retired before admission when %s fails",
    async (failure) => {
      const { packageRoot, pending, lock } = await fixture();
      const access = fs.access;
      const rm = fs.rm;
      const denial = Object.assign(new Error("release denied"), { code: "EACCES" });
      let pendingReads = 0;
      let retainedLock = "";
      vi.spyOn(fs, "access").mockImplementation(async (file, mode) => {
        if (file === pending && ++pendingReads === 2) {
          // The caller saw work before admission, but disposal retired it before
          // this generation's first pending check. It has no work to restore.
          await rm(pending);
          if (failure === "ownership") {
            await fs.rename(lock, path.join(packageRoot, "original-generation"));
            await fs.writeFile(lock, "replacement");
          }
          retainedLock = await fs.readFile(lock, "utf8");
        }
        return access(file, mode);
      });
      if (failure === "release") {
        const unlink = fs.unlink;
        vi.spyOn(fs, "unlink").mockImplementation(async (file) => {
          if (file === lock) {
            throw denial;
          }
          return unlink(file);
        });
      }
      const runScript = vi.fn();
      const completion = completePendingPackageLifecycle({ packageRoot, runScript });
      if (failure === "ownership") {
        await expect(completion).rejects.toThrow("lock generation changed");
      } else {
        await expect(completion).rejects.toMatchObject({
          name: "PackageLifecycleOwnershipError",
          cause: { name: "FsSafeError", code: "not-removable", cause: denial },
        });
      }
      expect(runScript).not.toHaveBeenCalled();
      expect(retainedLock).not.toBe("");
      expect(await fs.readFile(lock, "utf8")).toBe(retainedLock);
      await expect(fs.lstat(pending)).rejects.toMatchObject({ code: "ENOENT" });

      vi.restoreAllMocks();
      // Settle the test-created refusal evidence before the next invocation.
      await rm(lock);
      await expect(completePendingPackageLifecycle({ packageRoot, runScript })).resolves.toBe(
        false,
      );
      expect(runScript).not.toHaveBeenCalled();
    },
  );

  it("rechecks ownership after marker promotion before dispatching any script", async () => {
    const { packageRoot, pending, lock } = await fixture();
    const writeFile = fs.writeFile;
    vi.spyOn(fs, "writeFile").mockImplementation(async (file, data, options) => {
      if (file === pending) {
        await fs.rename(lock, path.join(packageRoot, "original-generation"));
        await writeFile(lock, "replacement\n");
        // The catch path also preserves pending evidence; only replace once.
        vi.mocked(fs.writeFile).mockImplementation(writeFile);
      }
      return writeFile(file, data, options);
    });
    const runScript = vi.fn();
    await expect(completePendingPackageLifecycle({ packageRoot, runScript })).rejects.toThrow(
      "lock generation changed",
    );
    expect(runScript).not.toHaveBeenCalled();
    expect(await fs.readFile(lock, "utf8")).toBe("replacement\n");
  });

  it("cleans its own partial publication after a failed write without running scripts", async () => {
    const { packageRoot, lock } = await fixture();
    vi.stubEnv("FS_SAFE_NATIVE_MODE", "off");
    const open = fs.open;
    const failure = Object.assign(new Error("publication failed"), { code: "EIO" });
    vi.spyOn(fs, "open").mockImplementation(async (file, flags, mode) => {
      const handle = await open(file, flags, mode);
      if (file === lock && isExclusiveCreate(flags)) {
        const write = handle.write.bind(handle);
        vi.spyOn(handle, "write").mockImplementation(async () => {
          await write(Buffer.from("{partial"));
          throw failure;
        });
      }
      return handle;
    });
    const runScript = vi.fn();
    await expect(completePendingPackageLifecycle({ packageRoot, runScript })).rejects.toMatchObject(
      {
        name: "FsSafeError",
        code: "invalid-path",
        cause: failure,
      },
    );
    expect(runScript).not.toHaveBeenCalled();
    await expect(fs.lstat(lock)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["create", "read"])("keeps %s permission errors distinguishable", async (phase) => {
    const { packageRoot, lock } = await fixture();
    vi.stubEnv("FS_SAFE_NATIVE_MODE", "off");
    if (phase === "read") {
      await fs.writeFile(lock, "{}");
    }
    const denial = Object.assign(new Error(`${phase} permission denied`), { code: "EACCES" });
    const open = fs.open;
    vi.spyOn(fs, "open").mockImplementation(async (file, flags, mode) => {
      if (
        file === lock &&
        (phase === "create"
          ? isExclusiveCreate(flags)
          : typeof flags === "number" && !isExclusiveCreate(flags))
      ) {
        throw denial;
      }
      return open(file, flags, mode);
    });
    const completion = completePendingPackageLifecycle({ packageRoot, runScript: vi.fn() });
    if (phase === "create") {
      await expect(completion).rejects.toMatchObject({
        name: "FsSafeError",
        code: "invalid-path",
        cause: denial,
      });
      await expect(fs.lstat(lock)).rejects.toMatchObject({ code: "ENOENT" });
    } else {
      await expect(completion).rejects.toMatchObject({
        name: "PackageLifecycleOwnershipError",
        cause: denial,
        lockPath: lock,
      });
      expect(await fs.readFile(lock, "utf8")).toBe("{}");
    }
  });

  it.each(["pending", "legacy"])(
    "retires the %s marker before a waiting owner can enter during disposal",
    async (shape) => {
      const { packageRoot, pending, lock } = await fixture();
      const legacy = path.join(packageRoot, "dist/openclaw-install-guard");
      await fs.mkdir(path.dirname(legacy), { recursive: true });
      await fs.writeFile(legacy, "legacy pending\n");
      if (shape === "legacy") {
        await fs.rm(pending);
      }
      const contended = createDeferred();
      const isPidAlive = pidAlive.isPidAlive;
      vi.spyOn(pidAlive, "isPidAlive").mockImplementation((pid) => {
        contended.resolve();
        return isPidAlive(pid);
      });
      const runScript = vi.fn();
      const rm = fs.rm;
      let contender: Promise<{ completed: boolean } | { error: unknown }> | undefined;
      vi.spyOn(fs, "rm").mockImplementation(async (file, options) => {
        if (file === (shape === "legacy" ? legacy : pending) && !contender) {
          // The contender observes pending work before disposal retires it.
          contender = completePendingPackageLifecycle({ packageRoot, runScript }).then(
            (completed) => ({ completed }),
            (error: unknown) => ({ error }),
          );
          await contended.promise;
        }
        return rm(file, options);
      });
      try {
        await discardPendingPackageLifecycle({
          packageRoots: [packageRoot],
          discard: async () => {
            await expect(fs.access(pending)).rejects.toMatchObject({ code: "ENOENT" });
            await expect(fs.access(legacy)).rejects.toMatchObject({ code: "ENOENT" });
            // A recursive remover may unlink the in-tree lock before other files.
            await rm(lock, { force: true });
            expect(runScript).not.toHaveBeenCalled();
            await rm(packageRoot, { recursive: true, force: true });
          },
        });
        // The provider may retain its held entry until disposal releases.
        // Do not make that release depend on this same-process waiter's settlement.
        const result = await contender;
        expect(result).toBeDefined();
        if (result && "error" in result) {
          expect(result.error).toBeInstanceOf(PackageLifecycleOwnershipError);
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
    },
  );

  it.each(["removed", "replacement"])(
    "does not enter a %s package root after waiting for disposal",
    async (state) => {
      const { packageRoot, pending, lock } = await fixture();
      const displacedRoot = path.join(tempDirs.make("openclaw-lifecycle-displaced-"), "package");
      const contended = createDeferred();
      const isPidAlive = pidAlive.isPidAlive;
      const runScript = vi.fn();
      let completion:
        | Promise<{ status: "complete"; completed: boolean } | { status: "failed"; error: unknown }>
        | undefined;
      vi.stubEnv("FS_SAFE_NATIVE_MODE", "off");
      vi.useFakeTimers({ toFake: ["setTimeout"] });
      vi.spyOn(pidAlive, "isPidAlive").mockImplementation((pid) => {
        contended.resolve();
        return isPidAlive(pid);
      });
      try {
        await discardPendingPackageLifecycle({
          packageRoots: [packageRoot],
          discard: async () => {
            completion = completePendingPackageLifecycle({ packageRoot, runScript }).then(
              (completed) => ({ status: "complete" as const, completed }),
              (error: unknown) => ({ status: "failed" as const, error }),
            );
            await Promise.race([
              contended.promise,
              completion.then(() => {
                throw new Error("expected lifecycle admission to wait for the disposal owner");
              }),
            ]);
            // Only the retry timer is controlled. Both acquisition and the
            // directory change use the real provider and filesystem operations.
            if (state === "removed") {
              await fs.rm(packageRoot, { recursive: true, force: true });
            } else {
              await fs.rename(packageRoot, displacedRoot);
              await fs.mkdir(packageRoot);
              await fs.writeFile(pending, "replacement pending\n");
            }
            await vi.advanceTimersByTimeAsync(100);
            await completion;
          },
        });
        if (state === "removed") {
          await expect(fs.lstat(packageRoot)).rejects.toMatchObject({ code: "ENOENT" });
        } else {
          expect(await fs.readFile(pending, "utf8")).toBe("replacement pending\n");
          await expect(fs.lstat(lock)).rejects.toMatchObject({ code: "ENOENT" });
        }
        expect(runScript).not.toHaveBeenCalled();
        expect(await completion).toMatchObject({
          status: "failed",
          error: {
            name: "PackageLifecycleOwnershipError",
            packageRoot,
            lockPath: lock,
            cause: { code: "path-mismatch" },
          },
        });
      } finally {
        vi.useRealTimers();
        await completion;
      }
    },
  );

  it("restores pending evidence when stage disposal fails", async () => {
    const { packageRoot, pending, lock } = await fixture();
    const failure = new Error("stage removal failed");
    await expect(
      discardPendingPackageLifecycle({
        packageRoots: [packageRoot],
        discard: async () => {
          throw failure;
        },
      }),
    ).rejects.toBe(failure);
    expect(await fs.readFile(pending, "utf8")).toBe("pending\n");
    await expect(fs.access(lock)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps ordinary unrooted disposal creation failures removable", async () => {
    const { packageRoot, pending, lock } = await fixture();
    const denial = Object.assign(new Error("disposal creation denied"), { code: "EACCES" });
    const open = fs.open;
    vi.stubEnv("FS_SAFE_NATIVE_MODE", "off");
    vi.spyOn(fs, "open").mockImplementation(async (file, flags, mode) => {
      if (file === lock && isExclusiveCreate(flags)) {
        throw denial;
      }
      return open(file, flags, mode);
    });
    const discard = vi.fn();
    await expect(
      discardPendingPackageLifecycle({ packageRoots: [packageRoot], discard }),
    ).rejects.toBe(denial);
    expect(discard).not.toHaveBeenCalled();
    expect(await fs.readFile(pending, "utf8")).toBe("pending\n");
    await expect(fs.lstat(lock)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves pending evidence and reports release failure", async () => {
    const { packageRoot, pending, lock } = await fixture();
    const unlink = fs.unlink;
    const denial = Object.assign(new Error("release denied"), { code: "EACCES" });
    vi.spyOn(fs, "unlink").mockImplementation(async (file) => {
      if (file === lock) {
        throw denial;
      }
      return unlink(file);
    });
    const runScript = vi.fn();
    await expect(completePendingPackageLifecycle({ packageRoot, runScript })).rejects.toMatchObject(
      {
        name: "PackageLifecycleOwnershipError",
        cause: { name: "FsSafeError", code: "not-removable", cause: denial },
      },
    );
    expect(runScript).toHaveBeenCalledTimes(2);
    expect(await fs.readFile(pending, "utf8")).toBe("pending\n");
    await expect(fs.access(lock)).resolves.toBeUndefined();
  });

  it("keeps settled script failure ordinary when marker restoration alone fails", async () => {
    const { packageRoot, pending, lock } = await fixture();
    const scriptFailure = new Error("script settled unsuccessfully");
    const restorationFailure = Object.assign(new Error("marker restoration failed"), {
      code: "EIO",
    });
    const writeFile = fs.writeFile;
    let scriptSettled = false;
    let failedRestorations = 0;
    vi.stubEnv("FS_SAFE_NATIVE_MODE", "off");
    vi.spyOn(fs, "writeFile").mockImplementation(async (file, data, options) => {
      if (file === pending && scriptSettled) {
        failedRestorations += 1;
        throw restorationFailure;
      }
      return writeFile(file, data, options);
    });
    const runScript = vi.fn(async () => {
      await fs.rm(pending);
      scriptSettled = true;
      throw scriptFailure;
    });
    const outcome = await completePendingPackageLifecycle({ packageRoot, runScript }).catch(
      (error: unknown) => error,
    );
    expect(scriptSettled).toBe(true);
    expect(failedRestorations).toBe(1);
    expect(runScript).toHaveBeenCalledTimes(1);
    await expect(fs.lstat(lock)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.lstat(pending)).rejects.toMatchObject({ code: "ENOENT" });
    expect(outcome).toBe(scriptFailure);
  });
});
