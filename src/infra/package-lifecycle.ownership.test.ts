import { spawnSync } from "node:child_process";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as pidAlive from "../shared/pid-alive.js";
import {
  completePendingPackageLifecycle,
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

describe("package lifecycle ownership", () => {
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

  it.each(["pending", "completed", "replacement"])(
    "handles a cooperative release before the contended snapshot with %s work",
    async (state) => {
      const { packageRoot, pending, lock } = await fixture();
      vi.stubEnv("FS_SAFE_NATIVE_MODE", "off");
      await fs.writeFile(lock, JSON.stringify(ownerPayload()));
      const open = fs.open;
      let released = false;
      vi.spyOn(fs, "open").mockImplementation(async (file, flags, mode) => {
        try {
          return await open(file, flags, mode);
        } catch (error) {
          if (!released && file === lock && flags === "wx") {
            expect(error).toMatchObject({ code: "EEXIST" });
            released = true;
            // The existing owner releases after exclusive creation collides, but
            // before the provider can read that owner's payload.
            await fs.rm(lock);
            if (state === "completed") {
              await fs.rm(pending);
            } else if (state === "replacement") {
              await fs.writeFile(lock, "{replacement publishing");
            }
          }
          throw error;
        }
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

  it("checks its generation before reporting that pending work disappeared", async () => {
    const { packageRoot, pending, lock } = await fixture();
    const access = fs.access;
    let pendingReads = 0;
    vi.spyOn(fs, "access").mockImplementation(async (file, mode) => {
      if (file === pending && ++pendingReads === 2) {
        await fs.rm(pending);
        await fs.rename(lock, path.join(packageRoot, "original-generation"));
        await fs.writeFile(lock, "replacement");
      }
      return access(file, mode);
    });
    const runScript = vi.fn();
    await expect(completePendingPackageLifecycle({ packageRoot, runScript })).rejects.toThrow(
      "lock generation changed",
    );
    expect(runScript).not.toHaveBeenCalled();
    expect(await fs.readFile(lock, "utf8")).toBe("replacement");
  });

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
      if (file === lock && flags === "wx") {
        const write = handle.writeFile.bind(handle);
        vi.spyOn(handle, "writeFile").mockImplementation(async () => {
          await write("{partial");
          throw failure;
        });
      }
      return handle;
    });
    const runScript = vi.fn();
    await expect(completePendingPackageLifecycle({ packageRoot, runScript })).rejects.toBe(failure);
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
      if (file === lock && (phase === "create" ? flags === "wx" : typeof flags === "number")) {
        throw denial;
      }
      return open(file, flags, mode);
    });
    const completion = completePendingPackageLifecycle({ packageRoot, runScript: vi.fn() });
    if (phase === "create") {
      await expect(completion).rejects.toBe(denial);
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

  it("preserves pending evidence and reports release failure", async () => {
    const { packageRoot, pending, lock } = await fixture();
    const rm = fs.rm;
    const denial = Object.assign(new Error("release denied"), { code: "EACCES" });
    vi.spyOn(fs, "rm").mockImplementation(async (file, options) => {
      if (file === lock) {
        throw denial;
      }
      return rm(file, options);
    });
    await expect(
      completePendingPackageLifecycle({ packageRoot, runScript: vi.fn() }),
    ).rejects.toMatchObject({ name: "PackageLifecycleOwnershipError", cause: denial });
    expect(await fs.readFile(pending, "utf8")).toBe("pending\n");
    await expect(fs.access(lock)).resolves.toBeUndefined();
  });
});
