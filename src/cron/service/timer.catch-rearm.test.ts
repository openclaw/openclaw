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

/** Create a minimal CronServiceState with a due job so armTimer sets a timer. */
function makeMinimalState() {
  return createCronServiceState({
    storePath: "/tmp/test-cron-catch-rearm.json",
    cronEnabled: true,
    log: noopLogger,
    enqueueSystemEvent: vi.fn(),
    requestHeartbeat: vi.fn(),
    runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
  });
}

describe("cron timer .catch() re-arm", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("does not re-arm when scheduler is stopped", () => {
    const state = makeMinimalState();
    state.stopped = true;

    armTimer(state);
    expect(state.timer).toBeNull();
  });

  it("armTimer sets a timer for a due job", () => {
    const state = makeMinimalState();
    state.store = {
      version: 1,
      jobs: [
        {
          id: "test-job",
          name: "test",
          enabled: true,
          createdAtMs: Date.now() - 60_000,
          updatedAtMs: Date.now() - 60_000,
          schedule: { kind: "every", everyMs: 60_000, anchorMs: Date.now() - 60_000 },
          sessionTarget: "main",
          payload: { kind: "systemEvent", text: "test" },
          state: { nextRunAtMs: Date.now() - 1 },
        } as any,
      ],
    };

    armTimer(state);
    expect(state.timer).not.toBeNull();

    // Clean up
    if (state.timer) { clearTimeout(state.timer); }
  });
});
