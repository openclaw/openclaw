import { afterEach, describe, expect, it, vi } from "vitest";
import type { CronJob } from "./types.js";
import { createCronStoreHarness, createNoopLogger } from "./service.test-harness.js";
import { createCronServiceState } from "./service/state.js";
import { armTimer } from "./service/timer.js";

const noopLogger = createNoopLogger();
const { makeStorePath } = createCronStoreHarness();

function createJobDueAt(nextRunAtMs: number): CronJob {
  return {
    id: "spin-test",
    name: "spin-test",
    enabled: true,
    deleteAfterRun: false,
    createdAtMs: nextRunAtMs - 1000,
    updatedAtMs: nextRunAtMs - 1000,
    schedule: { kind: "every", everyMs: 5 * 60_000 },
    sessionTarget: "isolated",
    wakeMode: "next-heartbeat",
    payload: { kind: "agentTurn", message: "test" },
    delivery: { mode: "none" },
    state: { nextRunAtMs },
  };
}

describe("armTimer spin-loop guard (#16839)", () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  it("uses MIN_TIMER_DELAY_MS when nextAt equals now (delay would be 0)", async () => {
    const timeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const store = await makeStorePath();
    const now = Date.parse("2026-02-06T10:00:00.000Z");

    const state = createCronServiceState({
      cronEnabled: true,
      storePath: store.storePath,
      log: noopLogger,
      nowMs: () => now,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeatNow: vi.fn(),
      runIsolatedAgentJob: vi.fn().mockResolvedValue({ status: "ok" }),
    });

    // Job is due exactly now → rawDelay = max(now - now, 0) = 0
    state.store = { version: 1, jobs: [createJobDueAt(now)] };

    armTimer(state);

    expect(state.timer).not.toBeNull();
    const delays = timeoutSpy.mock.calls
      .map(([, delay]) => delay)
      .filter((d): d is number => typeof d === "number");
    // Must use MIN_TIMER_DELAY_MS (500), not 0
    expect(delays.every((d) => d >= 500)).toBe(true);

    timeoutSpy.mockRestore();
    await store.cleanup();
  });

  it("uses MIN_TIMER_DELAY_MS when nextAt is in the past", async () => {
    const timeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const store = await makeStorePath();
    const now = Date.parse("2026-02-06T10:00:00.000Z");

    const state = createCronServiceState({
      cronEnabled: true,
      storePath: store.storePath,
      log: noopLogger,
      nowMs: () => now,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeatNow: vi.fn(),
      runIsolatedAgentJob: vi.fn().mockResolvedValue({ status: "ok" }),
    });

    // Job was due 5 seconds ago → rawDelay = max(past - now, 0) = 0
    state.store = { version: 1, jobs: [createJobDueAt(now - 5000)] };

    armTimer(state);

    expect(state.timer).not.toBeNull();
    const delays = timeoutSpy.mock.calls
      .map(([, delay]) => delay)
      .filter((d): d is number => typeof d === "number");
    expect(delays.every((d) => d >= 500)).toBe(true);

    timeoutSpy.mockRestore();
    await store.cleanup();
  });

  it("preserves normal delay when nextAt is in the future", async () => {
    const timeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const store = await makeStorePath();
    const now = Date.parse("2026-02-06T10:00:00.000Z");

    const state = createCronServiceState({
      cronEnabled: true,
      storePath: store.storePath,
      log: noopLogger,
      nowMs: () => now,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeatNow: vi.fn(),
      runIsolatedAgentJob: vi.fn().mockResolvedValue({ status: "ok" }),
    });

    // Job due in 30 seconds → normal delay, no spin guard
    state.store = { version: 1, jobs: [createJobDueAt(now + 30_000)] };

    armTimer(state);

    expect(state.timer).not.toBeNull();
    const delays = timeoutSpy.mock.calls
      .map(([, delay]) => delay)
      .filter((d): d is number => typeof d === "number");
    // Should use 30_000, not MIN_TIMER_DELAY_MS
    expect(delays).toContain(30_000);

    timeoutSpy.mockRestore();
    await store.cleanup();
  });
});
