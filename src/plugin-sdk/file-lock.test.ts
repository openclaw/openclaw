import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getProcessStartTime } from "../shared/pid-alive.js";
import { withFileLock } from "./file-lock.js";

/** Set a file's mtime to `msAgo` milliseconds in the past. */
async function ageFile(filePath: string, msAgo: number): Promise<void> {
  const t = (Date.now() - msAgo) / 1000; // fs.utimes takes seconds
  await fs.utimes(filePath, t, t);
}

const LOCK_OPTIONS = {
  retries: {
    retries: 2,
    factor: 1,
    minTimeout: 20,
    maxTimeout: 50,
  },
  stale: 5_000,
};

// More retries for tests where one waiter must survive while the other holds
// the lock for a non-trivial duration.
const RETRY_LOCK_OPTIONS = {
  retries: {
    retries: 10,
    factor: 1,
    minTimeout: 10,
    maxTimeout: 30,
  },
  stale: 5_000,
};

describe("withFileLock", () => {
  let tmpDir: string;
  let targetFile: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "file-lock-test-"));
    targetFile = path.join(tmpDir, "data.json");
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("acquires and releases the lock, allowing a second caller to proceed", async () => {
    const order: string[] = [];
    await withFileLock(targetFile, LOCK_OPTIONS, async () => {
      order.push("first-start");
      await new Promise((r) => setTimeout(r, 10));
      order.push("first-end");
    });
    await withFileLock(targetFile, LOCK_OPTIONS, async () => {
      order.push("second");
    });
    expect(order).toEqual(["first-start", "first-end", "second"]);
  });

  it("reclaims an empty lock file left by a crash between open and writeFile", async () => {
    // Simulate a crash in the open("wx")-to-writeFile window: the .lock file
    // exists but has empty (unparseable) content.
    const lockPath = `${targetFile}.lock`;
    await fs.mkdir(path.dirname(targetFile), { recursive: true });
    await fs.writeFile(lockPath, ""); // empty — no pid/createdAt written
    // An empty file with a young mtime is conservatively treated as a live
    // writer still in the open→writeFile window.  Age it past staleMs so the
    // mtime-based fallback marks it as stale.
    await ageFile(lockPath, LOCK_OPTIONS.stale + 1_000);

    let ran = false;
    await expect(
      withFileLock(targetFile, LOCK_OPTIONS, async () => {
        ran = true;
      }),
    ).resolves.toBeUndefined();
    expect(ran).toBe(true);
  });

  it("does not reclaim an empty lock file whose mtime is within staleMs (live writer window)", async () => {
    // A freshly-created empty lock belongs to a live writer still in the
    // open→writeFile window.  isStaleLock must NOT treat it as stale.
    const lockPath = `${targetFile}.lock`;
    await fs.mkdir(path.dirname(targetFile), { recursive: true });
    await fs.writeFile(lockPath, ""); // young mtime: effectively "just opened"

    // withFileLock should time out because the empty lock looks live.
    await expect(
      withFileLock(
        targetFile,
        { ...LOCK_OPTIONS, retries: { ...LOCK_OPTIONS.retries, retries: 1 } },
        async () => {},
      ),
    ).rejects.toThrow("file lock timeout");
  });

  it("reclaims a lock file containing partial/invalid JSON aged past staleMs", async () => {
    const lockPath = `${targetFile}.lock`;
    await fs.mkdir(path.dirname(targetFile), { recursive: true });
    await fs.writeFile(lockPath, '{"pid":'); // truncated JSON
    await ageFile(lockPath, LOCK_OPTIONS.stale + 1_000);

    let ran = false;
    await expect(
      withFileLock(targetFile, LOCK_OPTIONS, async () => {
        ran = true;
      }),
    ).resolves.toBeUndefined();
    expect(ran).toBe(true);
  });

  it("reclaims a lock file whose pid field is not a number, aged past staleMs", async () => {
    const lockPath = `${targetFile}.lock`;
    await fs.mkdir(path.dirname(targetFile), { recursive: true });
    await fs.writeFile(
      lockPath,
      JSON.stringify({ pid: "not-a-number", createdAt: new Date().toISOString() }),
    );
    await ageFile(lockPath, LOCK_OPTIONS.stale + 1_000);

    let ran = false;
    await expect(
      withFileLock(targetFile, LOCK_OPTIONS, async () => {
        ran = true;
      }),
    ).resolves.toBeUndefined();
    expect(ran).toBe(true);
  });

  it("reclaims a lock whose live PID has an old createdAt (PID-reuse via age check)", async () => {
    // Simulate PID reuse: the lock contains the test process's own (live) PID
    // but a createdAt older than staleMs, as if the original holder crashed and
    // the OS later assigned the same PID to an unrelated process.  The age
    // check must reclaim the lock even though the PID is alive.
    const lockPath = `${targetFile}.lock`;
    await fs.mkdir(path.dirname(targetFile), { recursive: true });
    await fs.writeFile(
      lockPath,
      JSON.stringify({
        pid: process.pid,
        createdAt: new Date(Date.now() - (LOCK_OPTIONS.stale + 5_000)).toISOString(),
      }),
    );

    let ran = false;
    await expect(
      withFileLock(targetFile, LOCK_OPTIONS, async () => {
        ran = true;
      }),
    ).resolves.toBeUndefined();
    expect(ran).toBe(true);
  });

  it.skipIf(process.platform !== "linux")(
    "reclaims a lock whose PID was recycled by a different process (startTime mismatch)",
    async () => {
      // On Linux, /proc/{pid}/stat provides a per-process start time that
      // survives PID reuse.  Write a lock with the current process's PID but a
      // startTime that cannot match — isStaleLock should detect the mismatch
      // and reclaim immediately, without waiting for createdAt to age out.
      const actualStartTime = getProcessStartTime(process.pid);
      if (actualStartTime === null) {
        // getProcessStartTime returned null unexpectedly on Linux — skip.
        return;
      }

      const lockPath = `${targetFile}.lock`;
      await fs.mkdir(path.dirname(targetFile), { recursive: true });
      await fs.writeFile(
        lockPath,
        JSON.stringify({
          pid: process.pid,
          createdAt: new Date().toISOString(), // recent — age check alone would not fire
          startTime: actualStartTime + 999_999, // deliberately wrong
        }),
      );

      let ran = false;
      await expect(
        withFileLock(targetFile, LOCK_OPTIONS, async () => {
          ran = true;
        }),
      ).resolves.toBeUndefined();
      expect(ran).toBe(true);
    },
  );

  it("two concurrent waiters on a stale lock never overlap inside fn()", async () => {
    // Plant a stale lock (dead PID, old timestamp) so both waiters will
    // simultaneously enter the stale-reclaim branch.  The inode guard must
    // prevent the slower waiter's unlink from deleting the faster waiter's
    // freshly-acquired lock, which would allow both fn() calls to run
    // concurrently and corrupt each other's read-modify-write sequences.
    const lockPath = `${targetFile}.lock`;
    await fs.mkdir(path.dirname(targetFile), { recursive: true });
    await fs.writeFile(lockPath, JSON.stringify({ pid: 0, createdAt: new Date(0).toISOString() }));

    let inside = 0; // number of concurrent fn() executions
    let maxInside = 0;
    const results: number[] = [];

    const run = async (id: number) => {
      // Use RETRY_LOCK_OPTIONS so the losing waiter has enough budget to
      // outlast the winning waiter's 20 ms hold without timing out.
      await withFileLock(targetFile, RETRY_LOCK_OPTIONS, async () => {
        inside += 1;
        maxInside = Math.max(maxInside, inside);
        await new Promise((r) => setTimeout(r, 20)); // hold the lock briefly
        results.push(id);
        inside -= 1;
      });
    };

    // Launch both concurrently so they race on the stale lock.
    await Promise.all([run(1), run(2)]);

    // Both callbacks must have run exactly once and never overlapped.
    expect(results.toSorted((a, b) => a - b)).toEqual([1, 2]);
    expect(maxInside).toBe(1);
  });
});
