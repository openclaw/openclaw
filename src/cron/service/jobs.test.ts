import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { CronJob } from "../types.js";
import type { CronServiceState } from "./state.js";
import { recomputeNextRuns } from "./jobs.js";

function makeJob(overrides: Partial<CronJob> = {}): CronJob {
  return {
    id: "job-1",
    name: "test",
    enabled: true,
    createdAtMs: 1000,
    updatedAtMs: 1000,
    schedule: { kind: "every", everyMs: 60_000, anchorMs: 0 },
    sessionTarget: "main",
    wakeMode: "next-heartbeat",
    payload: { kind: "systemEvent", text: "ping" },
    state: {},
    ...overrides,
  };
}

const noopLog = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

function makeState(jobs: CronJob[], nowMs: number): CronServiceState {
  return {
    deps: {
      nowMs: () => nowMs,
      log: noopLog,
      // Use a temp path that is unique per test run to avoid cross-test interference.
      storePath: path.join(
        os.tmpdir(),
        `cron-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
      ),
      cronEnabled: true,
      enqueueSystemEvent: () => {},
      requestHeartbeatNow: () => {},
      runIsolatedAgentJob: async () => ({ status: "ok" }),
    },
    store: { version: 1, jobs },
    timer: null,
    running: false,
    op: Promise.resolve(),
    warnedDisabled: false,
    storeLoadedAtMs: null,
    storeFileMtimeMs: null,
  };
}

describe("recomputeNextRuns", () => {
  it("advances past-due jobs by default", () => {
    const job = makeJob({ state: { nextRunAtMs: 5000 } });
    const state = makeState([job], 10_000);

    recomputeNextRuns(state);

    // nextRunAtMs should have been advanced past now (10_000)
    expect(job.state.nextRunAtMs).toBeGreaterThan(10_000);
  });

  it("preserves past-due jobs when preserveDue is true", () => {
    const job = makeJob({ state: { nextRunAtMs: 5000 } });
    const state = makeState([job], 10_000);

    const changed = recomputeNextRuns(state, { preserveDue: true });

    // nextRunAtMs must NOT be advanced — the timer should fire it first
    expect(job.state.nextRunAtMs).toBe(5000);
    expect(changed).toBe(false);
  });

  it("still fills in missing nextRunAtMs when preserveDue is true", () => {
    const job = makeJob({ state: {} });
    const state = makeState([job], 10_000);

    const changed = recomputeNextRuns(state, { preserveDue: true });

    // Missing nextRunAtMs should still be computed
    expect(job.state.nextRunAtMs).toBeTypeOf("number");
    expect(changed).toBe(true);
  });
});
