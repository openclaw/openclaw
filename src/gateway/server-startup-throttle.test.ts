import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyStartupRestartThrottle,
  scheduleStartupThrottleClear,
  __testing,
} from "./server-startup-throttle.js";

const {
  RAPID_THRESHOLD,
  RAPID_WINDOW_MS,
  readThrottleRecord,
  writeThrottleRecord,
  throttleFilePath,
} = __testing;

vi.mock("node:timers/promises", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:timers/promises")>();
  return { ...real, setTimeout: vi.fn(async () => undefined) };
});

const { setTimeout: mockSleep } = await import("node:timers/promises");

let stateDir: string;

beforeEach(async () => {
  stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-startup-throttle-test-"));
  vi.clearAllMocks();
});

afterEach(async () => {
  await fs.rm(stateDir, { recursive: true, force: true });
});

function makeLog() {
  return { warn: vi.fn() };
}

describe("applyStartupRestartThrottle", () => {
  it("does not sleep on first start", async () => {
    await applyStartupRestartThrottle({ stateDir, log: makeLog() });
    expect(mockSleep).not.toHaveBeenCalled();
  });

  it("does not sleep when the new rapidCount lands exactly at threshold", async () => {
    const now = Date.now();
    // prior count is RAPID_THRESHOLD - 1, so next start brings it to RAPID_THRESHOLD (not over)
    await writeThrottleRecord(stateDir, {
      startedAt: now - 1_000,
      rapidCount: RAPID_THRESHOLD - 1,
    });
    await applyStartupRestartThrottle({ stateDir, log: makeLog() });
    expect(mockSleep).not.toHaveBeenCalled();
  });

  it("sleeps when rapidCount exceeds threshold", async () => {
    const now = Date.now();
    await writeThrottleRecord(stateDir, { startedAt: now - 1_000, rapidCount: RAPID_THRESHOLD });
    const log = makeLog();
    await applyStartupRestartThrottle({ stateDir, log });
    // rapidCount is now RAPID_THRESHOLD + 1 — one step above threshold
    expect(mockSleep).toHaveBeenCalledWith(__testing.BACKOFF_BASE_MS);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("rapid restart detected"));
  });

  it("doubles backoff with each additional rapid start", async () => {
    const now = Date.now();
    await writeThrottleRecord(stateDir, {
      startedAt: now - 1_000,
      rapidCount: RAPID_THRESHOLD + 1,
    });
    await applyStartupRestartThrottle({ stateDir, log: makeLog() });
    expect(mockSleep).toHaveBeenCalledWith(__testing.BACKOFF_BASE_MS * 2);
  });

  it("caps backoff at BACKOFF_MAX_MS", async () => {
    const now = Date.now();
    // Very high count — backoff would overflow without cap
    await writeThrottleRecord(stateDir, { startedAt: now - 1_000, rapidCount: 100 });
    await applyStartupRestartThrottle({ stateDir, log: makeLog() });
    expect(mockSleep).toHaveBeenCalledWith(__testing.BACKOFF_MAX_MS);
  });

  it("resets count when previous start was outside the rapid window", async () => {
    const oldStart = Date.now() - RAPID_WINDOW_MS - 1_000;
    await writeThrottleRecord(stateDir, { startedAt: oldStart, rapidCount: 99 });
    await applyStartupRestartThrottle({ stateDir, log: makeLog() });
    expect(mockSleep).not.toHaveBeenCalled();
    const record = await readThrottleRecord(stateDir);
    expect(record?.rapidCount).toBe(1);
  });

  it("increments rapidCount in the sentinel file", async () => {
    const now = Date.now();
    await writeThrottleRecord(stateDir, { startedAt: now - 500, rapidCount: 1 });
    await applyStartupRestartThrottle({ stateDir, log: makeLog() });
    const record = await readThrottleRecord(stateDir);
    expect(record?.rapidCount).toBe(2);
  });

  it("proceeds without error when sentinel file is absent", async () => {
    await expect(
      applyStartupRestartThrottle({ stateDir, log: makeLog() }),
    ).resolves.toBeUndefined();
  });

  it("proceeds without error when sentinel file is corrupt", async () => {
    await fs.writeFile(throttleFilePath(stateDir), "not-json", "utf8");
    await expect(
      applyStartupRestartThrottle({ stateDir, log: makeLog() }),
    ).resolves.toBeUndefined();
    expect(mockSleep).not.toHaveBeenCalled();
  });

  it("proceeds without error when stateDir does not exist", async () => {
    const missing = path.join(stateDir, "nonexistent");
    await expect(
      applyStartupRestartThrottle({ stateDir: missing, log: makeLog() }),
    ).resolves.toBeUndefined();
  });
});

describe("scheduleStartupThrottleClear", () => {
  it("resets rapidCount to zero after the stable delay", async () => {
    vi.useFakeTimers();
    const now = Date.now();
    await writeThrottleRecord(stateDir, { startedAt: now, rapidCount: 10 });

    scheduleStartupThrottleClear({ stateDir, afterMs: 500 });
    await vi.advanceTimersByTimeAsync(600);

    const record = await readThrottleRecord(stateDir);
    expect(record?.rapidCount).toBe(0);
    vi.useRealTimers();
  });

  it("cancel function stops the clear from firing", async () => {
    vi.useFakeTimers();
    const now = Date.now();
    await writeThrottleRecord(stateDir, { startedAt: now, rapidCount: 10 });

    const cancel = scheduleStartupThrottleClear({ stateDir, afterMs: 500 });
    cancel();
    await vi.advanceTimersByTimeAsync(600);

    const record = await readThrottleRecord(stateDir);
    expect(record?.rapidCount).toBe(10);
    vi.useRealTimers();
  });
});
