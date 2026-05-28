import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { executeWithCacheAndStagger } from "./cache.js";

describe("probe cache", () => {
  let tempDir: string;
  let previousStateDir: string | undefined;

  beforeEach(() => {
    previousStateDir = process.env.OPENCLAW_STATE_DIR;
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-probe-cache-test-"));
    process.env.OPENCLAW_STATE_DIR = tempDir;
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    if (previousStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = previousStateDir;
    }
  });

  it("replays cached probe failures as failures instead of null successes", async () => {
    const failingExecutor = vi.fn(async () => {
      throw new Error("gateway unavailable");
    });

    await expect(
      executeWithCacheAndStagger("gateway", "status", failingExecutor, {
        baseDelayMs: 0,
        jitterMs: 0,
      }),
    ).rejects.toThrow("gateway unavailable");
    expect(failingExecutor).toHaveBeenCalledTimes(1);

    const successExecutor = vi.fn(async () => ({ ok: true }));

    await expect(
      executeWithCacheAndStagger("gateway", "status", successExecutor, {
        baseDelayMs: 0,
        jitterMs: 0,
      }),
    ).rejects.toThrow("Cached gateway probe status failed: gateway unavailable");
    expect(successExecutor).not.toHaveBeenCalled();
  });
});
