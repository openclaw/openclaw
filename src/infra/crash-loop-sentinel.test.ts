import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureEnv } from "../test-utils/env.js";
import {
  checkCrashLoopAndAbort,
  readCrashLoopSentinel,
  writeCrashLoopSentinel,
} from "./crash-loop-sentinel.js";

describe("crash loop sentinel", () => {
  let envSnapshot: ReturnType<typeof captureEnv>;
  let tempDir: string;

  beforeEach(async () => {
    envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-crash-loop-"));
    process.env.OPENCLAW_STATE_DIR = tempDir;
  });

  afterEach(async () => {
    envSnapshot.restore();
    vi.restoreAllMocks();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("single start — no abort", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {}) as never);
    await checkCrashLoopAndAbort();
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("two starts in 60s — no abort", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {}) as never);
    await checkCrashLoopAndAbort();
    await checkCrashLoopAndAbort();
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("three starts in 60s — calls process.exit(78)", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {}) as never);
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation((() => {}) as never);
    await checkCrashLoopAndAbort();
    await checkCrashLoopAndAbort();
    await checkCrashLoopAndAbort();
    expect(exitSpy).toHaveBeenCalledWith(78);
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining("Gateway crash loop detected"),
    );
  });

  it("three starts spread over >60s — no abort (old entries pruned)", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {}) as never);
    const now = Date.now();
    // Write two old entries (>60s ago) directly
    await writeCrashLoopSentinel({
      version: 1,
      startupTimestamps: [now - 90_000, now - 75_000],
    });
    // Third start (now) — old entries are pruned, so count = 1
    await checkCrashLoopAndAbort();
    expect(exitSpy).not.toHaveBeenCalled();
    // Verify only recent entry remains
    const data = await readCrashLoopSentinel();
    expect(data.startupTimestamps).toHaveLength(1);
  });

  it("diagnostic message includes pointer to openclaw doctor", async () => {
    vi.spyOn(process, "exit").mockImplementation((() => {}) as never);
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation((() => {}) as never);
    await checkCrashLoopAndAbort();
    await checkCrashLoopAndAbort();
    await checkCrashLoopAndAbort();
    const msg = stderrSpy.mock.calls.map((c) => String(c[0])).join("");
    expect(msg).toContain("openclaw doctor");
    expect(msg).toContain("openclaw.json");
  });
});
