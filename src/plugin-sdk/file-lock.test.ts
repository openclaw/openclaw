import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
  });

  it("reclaims a lock whose createdAt is expired even when the recorded PID is alive (PID reuse)", async () => {
    const filePath = path.join(tempDir, "oauth-pid-reuse");
    const lockPath = `${filePath}.lock`;
    const options = {
      retries: {
        retries: 5,
        factor: 1,
        minTimeout: 10,
        maxTimeout: 10,
      },
      stale: 1, // 1 ms — effectively expired immediately
    } as const;

    // Write a lock with the current process PID (alive!) but an ancient createdAt
    await fs.writeFile(
      lockPath,
      JSON.stringify({ pid: process.pid, createdAt: "2020-01-01T00:00:00.000Z" }, null, 2),
      "utf8",
    );

    // acquireFileLock should reclaim the stale lock because createdAt is expired,
    // even though isPidAlive(process.pid) === true.
    const handle = await acquireFileLock(filePath, options);
    await handle.release();
  }, 5_000);

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
});
