import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { withFileLock } from "./file-lock.js";

const LOCK_OPTIONS = {
  retries: {
    retries: 2,
    factor: 1,
    minTimeout: 20,
    maxTimeout: 50,
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

    // withFileLock must not time out; it should reclaim the empty lock and
    // run the callback without error.
    let ran = false;
    await expect(
      withFileLock(targetFile, LOCK_OPTIONS, async () => {
        ran = true;
      }),
    ).resolves.toBeUndefined();
    expect(ran).toBe(true);
  });

  it("reclaims a lock file containing partial/invalid JSON", async () => {
    const lockPath = `${targetFile}.lock`;
    await fs.mkdir(path.dirname(targetFile), { recursive: true });
    await fs.writeFile(lockPath, '{"pid":'); // truncated JSON

    let ran = false;
    await expect(
      withFileLock(targetFile, LOCK_OPTIONS, async () => {
        ran = true;
      }),
    ).resolves.toBeUndefined();
    expect(ran).toBe(true);
  });

  it("reclaims a lock file whose pid field is not a number", async () => {
    const lockPath = `${targetFile}.lock`;
    await fs.mkdir(path.dirname(targetFile), { recursive: true });
    await fs.writeFile(
      lockPath,
      JSON.stringify({ pid: "not-a-number", createdAt: new Date().toISOString() }),
    );

    let ran = false;
    await expect(
      withFileLock(targetFile, LOCK_OPTIONS, async () => {
        ran = true;
      }),
    ).resolves.toBeUndefined();
    expect(ran).toBe(true);
  });
});
