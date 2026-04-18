import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "vitest";
import {
  acquireFileLock,
  drainFileLockStateForTest,
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

  it("keeps retrying beyond the configured attempt count when stale windows are much larger", async () => {
    const filePath = path.join(tempDir, "oauth-refresh");
    const options = {
      retries: {
        retries: 1,
        factor: 1,
        minTimeout: 20,
        maxTimeout: 20,
      },
      stale: 100,
    } as const;

    const first = await acquireFileLock(filePath, options);
    const second = acquireFileLock(filePath, options);
    setTimeout(() => {
      void first.release();
    }, 50);

    const acquired = await second;
    await acquired.release();
  }, 5_000);
});
