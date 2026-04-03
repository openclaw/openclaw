import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureEnv } from "../test-utils/env.js";
import {
  CrashLoopAbortError,
  checkCrashLoopAndAbort,
  readCrashLoopSentinel,
  writeCrashLoopSentinel,
} from "./crash-loop-sentinel.js";

describe("crash loop sentinel", () => {
  let envSnapshot: ReturnType<typeof captureEnv>;
  let tempDir: string;

  beforeEach(async () => {
    envSnapshot = captureEnv(["OPENCLAW_STATE_DIR", "OPENCLAW_CONFIG_PATH"]);
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-crash-loop-"));
    process.env.OPENCLAW_STATE_DIR = tempDir;
  });

  afterEach(async () => {
    envSnapshot.restore();
    vi.restoreAllMocks();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("single start — no abort", async () => {
    await expect(checkCrashLoopAndAbort()).resolves.not.toThrow();
  });

  it("two starts in 60s — no abort", async () => {
    await checkCrashLoopAndAbort();
    await expect(checkCrashLoopAndAbort()).resolves.not.toThrow();
  });

  it("three starts in 60s — throws CrashLoopAbortError with exitCode 78", async () => {
    await checkCrashLoopAndAbort();
    await checkCrashLoopAndAbort();
    await expect(checkCrashLoopAndAbort()).rejects.toThrow(CrashLoopAbortError);
    await expect(checkCrashLoopAndAbort()).rejects.toMatchObject({ exitCode: 78 });
  });

  it("three starts in 60s — error message contains crash loop detected", async () => {
    await checkCrashLoopAndAbort();
    await checkCrashLoopAndAbort();
    try {
      await checkCrashLoopAndAbort();
      throw new Error("expected CrashLoopAbortError");
    } catch (err) {
      expect(err).toBeInstanceOf(CrashLoopAbortError);
      expect((err as CrashLoopAbortError).message).toContain("Gateway crash loop detected");
    }
  });

  it("three starts spread over >60s — no abort (old entries pruned)", async () => {
    const now = Date.now();
    // Write two old entries (>60s ago) directly
    await writeCrashLoopSentinel({
      version: 1,
      startupTimestamps: [now - 90_000, now - 75_000],
    });
    // Third start (now) — old entries are pruned, so count = 1
    await expect(checkCrashLoopAndAbort()).resolves.not.toThrow();
    // Verify only recent entry remains
    const data = await readCrashLoopSentinel();
    expect(data.startupTimestamps).toHaveLength(1);
  });

  it("diagnostic message includes pointer to openclaw doctor", async () => {
    await checkCrashLoopAndAbort();
    await checkCrashLoopAndAbort();
    try {
      await checkCrashLoopAndAbort();
      throw new Error("expected CrashLoopAbortError");
    } catch (err) {
      expect(err).toBeInstanceOf(CrashLoopAbortError);
      const msg = (err as CrashLoopAbortError).message;
      expect(msg).toContain("openclaw doctor");
      expect(msg).toContain("openclaw.json");
    }
  });
});
