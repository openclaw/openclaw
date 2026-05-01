import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { startHeartbeatRunner } from "./heartbeat-runner.js";
import { computeNextHeartbeatPhaseDueMs, resolveHeartbeatPhaseMs } from "./heartbeat-schedule.js";
import { resetHeartbeatWakeStateForTests } from "./heartbeat-wake.js";

/**
 * E2E tests for heartbeat active-hours-aware scheduling (#75487).
 *
 * Verifies that the scheduler seeks forward through phase-aligned slots to
 * find the first one that falls within the configured activeHours window,
 * rather than arming a timer for a quiet-hours slot and relying solely on
 * the runtime execution guard to skip it.
 */
describe("heartbeat scheduler: activeHours-aware scheduling (#75487)", () => {
  type RunOnce = Parameters<typeof startHeartbeatRunner>[0]["runOnce"];
  const TEST_SCHEDULER_SEED = "heartbeat-ah-schedule-test-seed";

  function useFakeHeartbeatTime(startMs: number) {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(startMs));
  }

  function heartbeatConfig(overrides?: {
    every?: string;
    activeHours?: { start: string; end: string; timezone?: string };
    userTimezone?: string;
  }): OpenClawConfig {
    return {
      agents: {
        defaults: {
          heartbeat: {
            every: overrides?.every ?? "4h",
            ...(overrides?.activeHours ? { activeHours: overrides.activeHours } : {}),
          },
          ...(overrides?.userTimezone ? { userTimezone: overrides.userTimezone } : {}),
        },
      },
    } as OpenClawConfig;
  }

  function resolveDueFromNow(nowMs: number, intervalMs: number, agentId: string) {
    return computeNextHeartbeatPhaseDueMs({
      nowMs,
      intervalMs,
      phaseMs: resolveHeartbeatPhaseMs({
        schedulerSeed: TEST_SCHEDULER_SEED,
        agentId,
        intervalMs,
      }),
    });
  }

  afterEach(() => {
    resetHeartbeatWakeStateForTests();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("skips quiet-hours slots and fires at the first in-window phase slot", async () => {
    // Active window: 09:00–17:00 UTC. Interval: 4h.
    // Start the clock at 16:30 UTC — the next raw phase slot will be computed
    // from this time.  For a 4h interval the phase-aligned slots repeat every
    // 4h.  We resolve the first raw due, assert it falls outside the active
    // window, then verify the runner arms its timer for the first in-window
    // slot (which must be >= 09:00 the next day).
    const startMs = Date.parse("2026-06-15T16:30:00.000Z");
    useFakeHeartbeatTime(startMs);

    const intervalMs = 4 * 60 * 60_000;
    const callTimes: number[] = [];
    const runSpy: RunOnce = vi.fn().mockImplementation(async () => {
      callTimes.push(Date.now());
      return { status: "ran", durationMs: 1 };
    });

    const runner = startHeartbeatRunner({
      cfg: heartbeatConfig({
        every: "4h",
        activeHours: { start: "09:00", end: "17:00", timezone: "UTC" },
      }),
      runOnce: runSpy,
      stableSchedulerSeed: TEST_SCHEDULER_SEED,
    });

    // Compute what the raw (timezone-unaware) first due would be.
    const rawDueMs = resolveDueFromNow(startMs, intervalMs, "main");

    // Advance past the raw due — the scheduler should NOT fire because that
    // slot falls outside active hours (it's after 17:00).
    await vi.advanceTimersByTimeAsync(rawDueMs - startMs + 1);
    // If the scheduler is timezone-aware, it shouldn't have fired at the raw
    // quiet-hours slot.  It might have already found and armed the first
    // in-window slot.

    // Now advance to 09:01 on the next day plus enough time for any phase
    // offset — the scheduler should fire within the active window.
    const nextDay0900 = Date.parse("2026-06-16T09:00:00.000Z");
    const safeEndOfWindow = Date.parse("2026-06-16T17:00:00.000Z");
    await vi.advanceTimersByTimeAsync(safeEndOfWindow - Date.now());

    // The first call must have happened within the active window.
    expect(runSpy).toHaveBeenCalled();
    const firstCallTime = callTimes[0]!;
    const firstCallHourUTC = new Date(firstCallTime).getUTCHours();
    expect(firstCallHourUTC).toBeGreaterThanOrEqual(9);
    expect(firstCallHourUTC).toBeLessThan(17);

    runner.stop();
  });

  it("fires immediately when the first phase slot is already within active hours", async () => {
    // Active window: 08:00–20:00 UTC. Interval: 4h.
    // Start at 10:00 UTC — the first phase slot is within active hours.
    const startMs = Date.parse("2026-06-15T10:00:00.000Z");
    useFakeHeartbeatTime(startMs);

    const intervalMs = 4 * 60 * 60_000;
    const runSpy: RunOnce = vi.fn().mockResolvedValue({ status: "ran", durationMs: 1 });

    const runner = startHeartbeatRunner({
      cfg: heartbeatConfig({
        every: "4h",
        activeHours: { start: "08:00", end: "20:00", timezone: "UTC" },
      }),
      runOnce: runSpy,
      stableSchedulerSeed: TEST_SCHEDULER_SEED,
    });

    const rawDueMs = resolveDueFromNow(startMs, intervalMs, "main");

    // The raw due should be within active hours — advance to it.
    await vi.advanceTimersByTimeAsync(rawDueMs - startMs + 1);

    expect(runSpy).toHaveBeenCalledTimes(1);
    runner.stop();
  });

  it("seeks forward correctly with a non-UTC timezone (e.g. America/New_York)", async () => {
    // Active window: 09:00–17:00 America/New_York (EDT = UTC-4 in June).
    // So active hours in UTC = 13:00–21:00.
    // Interval: 4h. Start at 21:30 UTC (17:30 ET = outside window).
    const startMs = Date.parse("2026-06-15T21:30:00.000Z");
    useFakeHeartbeatTime(startMs);

    const intervalMs = 4 * 60 * 60_000;
    const callTimes: number[] = [];
    const runSpy: RunOnce = vi.fn().mockImplementation(async () => {
      callTimes.push(Date.now());
      return { status: "ran", durationMs: 1 };
    });

    const runner = startHeartbeatRunner({
      cfg: heartbeatConfig({
        every: "4h",
        activeHours: { start: "09:00", end: "17:00", timezone: "America/New_York" },
      }),
      runOnce: runSpy,
      stableSchedulerSeed: TEST_SCHEDULER_SEED,
    });

    // Advance through two full days to capture the first fire.
    await vi.advanceTimersByTimeAsync(48 * 60 * 60_000);

    expect(runSpy).toHaveBeenCalled();
    // Verify the first call was within the ET active window.
    // 09:00 ET = 13:00 UTC, 17:00 ET = 21:00 UTC (during EDT, June).
    const firstCallTime = callTimes[0]!;
    const firstCallHourUTC = new Date(firstCallTime).getUTCHours();
    // In ET active hours → UTC 13:00–21:00
    expect(firstCallHourUTC).toBeGreaterThanOrEqual(13);
    expect(firstCallHourUTC).toBeLessThan(21);

    runner.stop();
  });

  it("advances to in-window slot after a quiet-hours skip during interval runs", async () => {
    // Active window: 09:00–17:00 UTC. Interval: 4h.
    // Start at 09:00 UTC — first fire is within window.
    // After the first fire, the next raw slot may fall outside the window.
    // Verify the scheduler seeks forward past quiet-hours slots.
    const startMs = Date.parse("2026-06-15T09:00:00.000Z");
    useFakeHeartbeatTime(startMs);

    const intervalMs = 4 * 60 * 60_000;
    const callTimes: number[] = [];
    const runSpy: RunOnce = vi.fn().mockImplementation(async () => {
      callTimes.push(Date.now());
      return { status: "ran", durationMs: 1 };
    });

    const runner = startHeartbeatRunner({
      cfg: heartbeatConfig({
        every: "4h",
        activeHours: { start: "09:00", end: "17:00", timezone: "UTC" },
      }),
      runOnce: runSpy,
      stableSchedulerSeed: TEST_SCHEDULER_SEED,
    });

    // Advance through 48 hours — collect all fire times.
    await vi.advanceTimersByTimeAsync(48 * 60 * 60_000);

    // Every single fire must be within 09:00–17:00 UTC.
    expect(callTimes.length).toBeGreaterThan(0);
    for (const t of callTimes) {
      const hour = new Date(t).getUTCHours();
      expect(
        hour,
        `fire at ${new Date(t).toISOString()} is outside active window`,
      ).toBeGreaterThanOrEqual(9);
      expect(hour, `fire at ${new Date(t).toISOString()} is outside active window`).toBeLessThan(
        17,
      );
    }

    runner.stop();
  });

  it("does not loop indefinitely when activeHours window is zero-width", async () => {
    // start === end means never-active. The scheduler should arm at the raw
    // slot (fallback) and the runtime guard will skip execution.
    const startMs = Date.parse("2026-06-15T10:00:00.000Z");
    useFakeHeartbeatTime(startMs);

    const runSpy: RunOnce = vi.fn().mockResolvedValue({ status: "skipped", reason: "quiet-hours" });

    const runner = startHeartbeatRunner({
      cfg: heartbeatConfig({
        every: "30m",
        activeHours: { start: "12:00", end: "12:00", timezone: "UTC" },
      }),
      runOnce: runSpy,
      stableSchedulerSeed: TEST_SCHEDULER_SEED,
    });

    // Advance 2 hours — the scheduler should not hang or spin.
    await vi.advanceTimersByTimeAsync(2 * 60 * 60_000);

    // The runner fires because start === end returns false from
    // isWithinActiveHours, so the seek falls back to the raw slot.
    // runOnce returns quiet-hours skip each time.
    expect(runSpy).toHaveBeenCalled();
    runner.stop();
  });
});
