import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getProcessStartTime } from "../shared/pid-alive.js";
import {
  acquireFileLock,
  drainFileLockStateForTest,
  FILE_LOCK_TIMEOUT_ERROR_CODE,
  resetFileLockStateForTest,
} from "./file-lock.js";

describe("acquireFileLock", () => {
  let tempDir = "";

  beforeEach(async () => {
    resetFileLockStateForTest();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-file-lock-"));
  });

  afterEach(async () => {
    await drainFileLockStateForTest();
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
    vi.restoreAllMocks();
  });

  it("respects the configured retry budget even when stale windows are much larger", async () => {
    const filePath = path.join(tempDir, "oauth-refresh");
    const lockPath = `${filePath}.lock`;
    const options = {
      retries: {
        retries: 1,
        factor: 1,
        minTimeout: 20,
        maxTimeout: 20,
      },
      stale: 100,
    } as const;

    await fs.writeFile(
      lockPath,
      JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }, null, 2),
      "utf8",
    );
    setTimeout(() => {
      void fs.rm(lockPath, { force: true });
    }, 50);

    await expect(acquireFileLock(filePath, options)).rejects.toSatisfy((error) => {
      expect(error).toMatchObject({
        code: FILE_LOCK_TIMEOUT_ERROR_CODE,
      });
      expect((error as { lockPath?: string }).lockPath).toBeTruthy();
      expect((error as { lockPath?: string }).lockPath).toMatch(/oauth-refresh\.lock$/);
      return true;
    });
  }, 5_000);

  it("closes an opened lock handle when writing the owner payload fails", async () => {
    const filePath = path.join(tempDir, "write-fails");
    const writeError = new Error("owner write failed");
    const close = vi.fn().mockResolvedValue(undefined);
    vi.spyOn(fs, "open").mockResolvedValue({
      close,
      writeFile: vi.fn().mockRejectedValue(writeError),
    } as unknown as Awaited<ReturnType<typeof fs.open>>);

    await expect(
      acquireFileLock(filePath, {
        retries: {
          retries: 0,
          factor: 1,
          minTimeout: 1,
          maxTimeout: 1,
        },
        stale: 100,
      }),
    ).rejects.toThrow(writeError);

    expect(close).toHaveBeenCalledTimes(1);
  });

  it.skipIf(process.platform !== "linux")(
    "persists the current process starttime when acquiring a lock on Linux",
    async () => {
      const filePath = path.join(tempDir, "starttime-write");
      const handle = await acquireFileLock(filePath, {
        retries: { retries: 0, factor: 1, minTimeout: 1, maxTimeout: 1 },
        stale: 1_000,
      });
      try {
        const raw = await fs.readFile(handle.lockPath, "utf8");
        const parsed = JSON.parse(raw) as {
          pid?: number;
          starttime?: number;
          createdAt?: string;
        };
        expect(parsed.pid).toBe(process.pid);
        expect(typeof parsed.starttime).toBe("number");
        expect(parsed.starttime).toBe(getProcessStartTime(process.pid));
        expect(typeof parsed.createdAt).toBe("string");
      } finally {
        await handle.release();
      }
    },
  );

  it.skipIf(process.platform !== "linux")(
    "treats a lock as stale when the persisted starttime mismatches the live process",
    async () => {
      const filePath = path.join(tempDir, "starttime-mismatch");
      const lockPath = `${filePath}.lock`;
      const liveStarttime = getProcessStartTime(process.pid);
      expect(typeof liveStarttime).toBe("number");
      await fs.writeFile(
        lockPath,
        JSON.stringify(
          {
            pid: process.pid,
            starttime: (liveStarttime as number) + 1,
            createdAt: new Date().toISOString(),
          },
          null,
          2,
        ),
        "utf8",
      );

      const handle = await acquireFileLock(filePath, {
        retries: { retries: 1, factor: 1, minTimeout: 1, maxTimeout: 1 },
        stale: 60_000,
      });
      try {
        expect(handle.lockPath).toBe(lockPath);
      } finally {
        await handle.release();
      }
    },
  );

  it("falls back to createdAt age when the lock payload omits starttime", async () => {
    const filePath = path.join(tempDir, "legacy-payload");
    const lockPath = `${filePath}.lock`;
    const oldCreatedAt = new Date(Date.now() - 60_000).toISOString();
    await fs.writeFile(
      lockPath,
      JSON.stringify({ pid: process.pid, createdAt: oldCreatedAt }, null, 2),
      "utf8",
    );

    const handle = await acquireFileLock(filePath, {
      retries: { retries: 1, factor: 1, minTimeout: 1, maxTimeout: 1 },
      stale: 100,
    });
    try {
      expect(handle.lockPath).toMatch(/legacy-payload\.lock$/);
    } finally {
      await handle.release();
    }
  });

  it.skipIf(process.platform !== "linux")(
    "removes a starttime-mismatched lock and replaces it with a fresh owner payload",
    async () => {
      const filePath = path.join(tempDir, "starttime-recovery");
      const lockPath = `${filePath}.lock`;
      const liveStarttime = getProcessStartTime(process.pid);
      expect(typeof liveStarttime).toBe("number");
      const previousCreatedAt = new Date(Date.now() - 5_000).toISOString();
      await fs.writeFile(
        lockPath,
        JSON.stringify(
          {
            pid: process.pid,
            starttime: (liveStarttime as number) + 1,
            createdAt: previousCreatedAt,
          },
          null,
          2,
        ),
        "utf8",
      );

      const handle = await acquireFileLock(filePath, {
        retries: { retries: 1, factor: 1, minTimeout: 1, maxTimeout: 1 },
        stale: 60_000,
      });
      try {
        const raw = await fs.readFile(handle.lockPath, "utf8");
        const parsed = JSON.parse(raw) as {
          pid?: number;
          starttime?: number;
          createdAt?: string;
        };
        expect(parsed.pid).toBe(process.pid);
        expect(parsed.starttime).toBe(liveStarttime);
        expect(parsed.createdAt).not.toBe(previousCreatedAt);
      } finally {
        await handle.release();
      }
    },
  );
});
