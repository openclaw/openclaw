import { existsSync, readFileSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withEnvAsync } from "../test-utils/env.js";
import {
  acquireFileLock,
  drainFileLockStateForTest,
  FILE_LOCK_STALE_ERROR_CODE,
  FILE_LOCK_TIMEOUT_ERROR_CODE,
  reclaimDefinitelyStaleFileLock,
  resetFileLockStateForTest,
} from "./file-lock.js";

const retries = { retries: 0, factor: 1, minTimeout: 1, maxTimeout: 1 } as const;
const staleOptions = { retries, stale: 10 } as const;
const ownerOptions = { retries, stale: 60_000 } as const;
const deadPid = 2 ** 30;
const missing = (filePath: string) =>
  expect(fs.access(filePath)).rejects.toMatchObject({ code: "ENOENT" });
const timesOut = (lock: ReturnType<typeof acquireFileLock>) =>
  expect(lock).rejects.toMatchObject({ code: FILE_LOCK_TIMEOUT_ERROR_CODE });

async function writeLock(lockPath: string, pid = deadPid, createdAt = "2000-01-01T00:00:00Z") {
  const bytes = JSON.stringify({ pid, createdAt });
  await fs.writeFile(lockPath, bytes, "utf8");
  return bytes;
}

describe("acquireFileLock", () => {
  let tempDir = "";
  let filePath: string;
  let lockPath: string;
  const acquire = (options: Parameters<typeof acquireFileLock>[1] = ownerOptions) =>
    acquireFileLock(filePath, options);

  beforeEach(async () => {
    resetFileLockStateForTest();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-file-lock-"));
    filePath = path.join(tempDir, "oauth-refresh");
    lockPath = `${filePath}.lock`;
  });

  afterEach(async () => {
    await drainFileLockStateForTest();
    vi.restoreAllMocks();
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("respects the configured retry budget even when stale windows are much larger", async () => {
    const options = {
      retries: { ...retries, retries: 1, minTimeout: 20, maxTimeout: 20 },
      stale: 100,
    };
    await writeLock(lockPath, process.pid, new Date().toISOString());

    await expect(acquire(options)).rejects.toMatchObject({
      code: FILE_LOCK_TIMEOUT_ERROR_CODE,
      lockPath: path.join(await fs.realpath(tempDir), "oauth-refresh.lock"),
    });
  }, 5_000);

  it("reclaims a stale lock when its owner pid is dead", async () => {
    await writeLock(lockPath);
    const lock = await acquire(staleOptions);
    await expect(fs.readFile(lockPath, "utf8")).resolves.toContain(`"pid": ${process.pid}`);
    await lock.release();
  });

  it.runIf(process.platform !== "win32")(
    "shares canonical aliases for one logical owner until the final release",
    async () => {
      const realDir = path.join(tempDir, "real");
      const linkDir = path.join(tempDir, "link");
      await fs.mkdir(realDir);
      await fs.symlink(realDir, linkDir, "dir");
      const realPath = path.join(realDir, "state.json");
      const linkPath = path.join(linkDir, "state.json");
      const options = { ...ownerOptions, reentrantOwner: "test-operation:alias" };

      const first = await acquireFileLock(realPath, options);
      const second = await acquireFileLock(linkPath, options);
      try {
        expect(second.lockPath).toBe(first.lockPath);
        await first.release();
        await fs.access(first.lockPath);
        await second.release();
        await missing(first.lockPath);
      } finally {
        await first.release();
        await second.release();
      }
    },
  );

  it.each([
    ["different", "test-operation:second"],
    ["absent", undefined],
  ] as const)("makes a %s logical owner contend normally", async (_label, reentrantOwner) => {
    const first = await acquire({ ...ownerOptions, reentrantOwner: "test-operation:first" });
    try {
      await timesOut(acquire({ ...ownerOptions, reentrantOwner }));
    } finally {
      await first.release();
    }
  });

  it.each(["fail-closed", "unsupported-runtime-policy"])(
    "does not grant stale removal for %s policy",
    async (staleRecovery) => {
      const bytes = await writeLock(lockPath);
      // JavaScript consumers can supply policies outside the TypeScript union.
      const runtimeOptions = JSON.parse(`{"staleRecovery":"${staleRecovery}"}`);
      await expect(acquire({ ...staleOptions, ...runtimeOptions })).rejects.toMatchObject({
        code: FILE_LOCK_STALE_ERROR_CODE,
        ...(staleRecovery === "fail-closed"
          ? { message: expect.stringContaining(`[owner-process-exited pid=${deadPid}`) }
          : {}),
      });
      expect(await fs.readFile(lockPath, "utf8")).toBe(bytes);
    },
  );

  it.each([
    ["definitely dead", deadPid, true],
    ["live", process.pid, false],
    ["unknown owner", undefined, false],
  ] as const)("requires definite owner retirement for %s sidecars", async (_name, pid, reclaim) => {
    const bytes = JSON.stringify({ pid, createdAt: "2000-01-01T00:00:00Z" });
    await fs.writeFile(lockPath, bytes);
    const options = {
      ...staleOptions,
      staleRecovery: "remove-if-definitely-stale",
    } as const;
    if (reclaim) {
      const held = await acquire(options);
      expect(JSON.parse(await fs.readFile(lockPath, "utf8")).pid).toBe(process.pid);
      await held.release();
    } else {
      await timesOut(acquire(options));
      expect(await fs.readFile(lockPath, "utf8")).toBe(bytes);
    }
  });

  it("does not unlink an ownerless sidecar while its creator still holds it", async () => {
    const owner = await fs.open(lockPath, "wx");
    try {
      const staleAt = new Date(Date.now() - 60_000);
      await owner.utimes(staleAt, staleAt);
      const before = await owner.stat();

      await timesOut(acquire(staleOptions));

      const after = await fs.stat(lockPath);
      expect({ dev: after.dev, ino: after.ino }).toEqual({ dev: before.dev, ino: before.ino });
      await owner.writeFile(`${JSON.stringify({ pid: process.pid })}\n`, "utf8");
      await expect(fs.readFile(lockPath, "utf8")).resolves.toContain(`"pid":${process.pid}`);
    } finally {
      await owner.close();
      await fs.rm(lockPath, { force: true });
    }
  });

  it("releases an acquired lock when the handoff guard rejects it", async () => {
    const guardError = new Error("resource became borrowed");

    await expect(
      acquire({
        ...ownerOptions,
        assertResourceUnborrowed: () => {
          // Reject only after the real lock sidecar contains its owner payload.
          if (existsSync(lockPath) && readFileSync(lockPath, "utf8").length > 0) {
            throw guardError;
          }
        },
      }),
    ).rejects.toBe(guardError);

    await missing(lockPath);
    const next = await acquire();
    await next.release();
  });

  it("closes an opened lock handle when writing the owner payload fails", async () => {
    const writeError = new Error("owner write failed");
    const open = fs.open;
    const opened: Awaited<ReturnType<typeof fs.open>>[] = [];
    vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await open(...args);
      if (args[1] === "wx") {
        opened.push(handle);
        vi.spyOn(handle, "writeFile").mockRejectedValue(writeError);
      }
      return handle;
    });

    // Inject the failure at the real JavaScript FileHandle write boundary.
    await withEnvAsync({ FS_SAFE_NATIVE_MODE: "off" }, async () => {
      await expect(acquire({ retries, stale: 100 })).rejects.toThrow(writeError);
    });

    expect(opened).toHaveLength(1);
    for (const handle of opened) {
      await expect(handle.stat()).rejects.toMatchObject({ code: "EBADF" });
    }
    await missing(lockPath);
  });

  it("reclaims a definitely stale retired lock sidecar", async () => {
    const retiredPath = path.join(tempDir, "embed.lock.lock");
    await writeLock(retiredPath, deadPid, new Date().toISOString());

    await expect(reclaimDefinitelyStaleFileLock(retiredPath)).resolves.toBe("removed");
    await missing(retiredPath);
    await expect(reclaimDefinitelyStaleFileLock(retiredPath)).resolves.toBe("missing");
  });

  it("retains live, malformed, and symlink lock sidecars", async () => {
    const livePath = path.join(tempDir, "live.lock.lock");
    const malformedPath = path.join(tempDir, "malformed.lock.lock");
    const staleTargetPath = path.join(tempDir, "stale-target.lock");
    const symlinkPath = path.join(tempDir, "symlink.lock.lock");
    await writeLock(livePath, process.pid);
    await fs.writeFile(malformedPath, "{", "utf8");
    await writeLock(staleTargetPath);
    await fs.symlink(staleTargetPath, symlinkPath);

    await expect(reclaimDefinitelyStaleFileLock(livePath)).resolves.toBe("retained");
    await expect(reclaimDefinitelyStaleFileLock(malformedPath)).resolves.toBe("retained");
    await expect(reclaimDefinitelyStaleFileLock(symlinkPath)).resolves.toBe("retained");
    await expect(fs.readFile(livePath, "utf8")).resolves.toContain(`"pid":${process.pid}`);
    await expect(fs.readFile(malformedPath, "utf8")).resolves.toBe("{");
    expect((await fs.lstat(symlinkPath)).isSymbolicLink()).toBe(true);
    await expect(fs.readFile(staleTargetPath, "utf8")).resolves.toContain(`"pid":${2 ** 30}`);
  });

  it("retains a stale snapshot replaced before reclaim approval", async () => {
    const replacedPath = path.join(tempDir, "replaced.lock.lock");
    await writeLock(replacedPath);
    const originalLstat = fs.lstat.bind(fs);
    let lockLstatCalls = 0;
    vi.spyOn(fs, "lstat").mockImplementation(async (...args) => {
      const [candidate] = args;
      if (candidate === replacedPath && ++lockLstatCalls === 3) {
        await fs.rm(replacedPath);
        await writeLock(replacedPath, process.pid);
      }
      return await originalLstat(...args);
    });

    await expect(reclaimDefinitelyStaleFileLock(replacedPath)).resolves.toBe("retained");
    await expect(fs.readFile(replacedPath, "utf8")).resolves.toContain(`"pid":${process.pid}`);
  });
});
