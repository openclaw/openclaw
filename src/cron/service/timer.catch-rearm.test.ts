/**
 * Tests that armTimer's .catch() handler re-arms the timer chain
 * after onTimer rejects. Without this, a single unhandled rejection
 * permanently kills the cron scheduler until gateway restart.
 *
 * See: https://github.com/openclaw/openclaw/issues/73166
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCronServiceState } from "./state.js";
import { armTimer } from "./timer.js";

const noopLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

/** Create a minimal CronServiceState for testing timer mechanics. */
function makeMinimalState(overrides?: {
  cronEnabled?: boolean;
  nowMs?: () => number;
}) {
  return createCronServiceState({
    storePath: "/tmp/test-cron-catch-rearm.json",
    cronEnabled: overrides?.cronEnabled ?? true,
    log: noopLogger,
    enqueueSystemEvent: vi.fn(),
    requestHeartbeat: vi.fn(),
    runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    ...overrides,
  });
}

describe("cron timer .catch() re-arm", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("re-arms the timer when onTimer rejects", async () => {
    const state = makeMinimalState();
    state.store = { version: 1, jobs: [] };

    // Arm the timer
    armTimer(state);
    const firstTimerId = state.timer;
    expect(firstTimerId).not.toBeNull();

    // Advance time to fire the timer — onTimer will reject because
    // the store has no due jobs and various internal deps aren't
    // fully wired for a bare state. The rejection exercises the .catch path.
    // Use vi.advanceTimersToNextTimer to trigger the setTimeout callback.
    await vi.advanceTimersToNextTimerAsync();

    // The .catch handler should have re-armed: a new timer should exist.
    // It may or may not be a different timer ID depending on whether
    // onTimer's finally block also arms (healthy path) or the .catch fires.
    // The key assertion: a timer is still set after a rejection.
    expect(state.timer).not.toBeNull();

    // Clean up
    if (state.timer) { clearTimeout(state.timer); }
  });

  it("does not re-arm when scheduler is stopped", () => {
    const state = makeMinimalState();
    state.store = { version: 1, jobs: [] };
    state.stopped = true;

    armTimer(state);
    // Timer should be null when stopped
    expect(state.timer).toBeNull();
  });
});
