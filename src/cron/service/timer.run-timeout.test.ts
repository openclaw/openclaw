import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createAbortAwareIsolatedRunner,
  createDeferred,
  createIsolatedRegressionJob,
  noopLogger,
  setupCronRegressionFixtures,
  writeCronJobs,
} from "../../../test/helpers/cron/service-regression-fixtures.js";
import { findTaskByRunId, resetTaskRegistryForTests } from "../../tasks/task-registry.js";
import { createCronServiceState } from "./state.js";
import type { CronServiceDeps } from "./state.js";
import { onTimer } from "./timer.js";

const FAST_TIMEOUT_SECONDS = 1;
const timerFixtures = setupCronRegressionFixtures({
  prefix: "cron-service-timer-run-timeout-",
});

function withStateDirForStorePath(storePath: string) {
  const stateRoot = path.dirname(path.dirname(storePath));
  const originalStateDir = process.env.OPENCLAW_STATE_DIR;
  process.env.OPENCLAW_STATE_DIR = stateRoot;
  resetTaskRegistryForTests();
  return () => {
    if (originalStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = originalStateDir;
    }
    resetTaskRegistryForTests();
  };
}

/**
 * Runner that deliberately ignores the abort signal so the `timeoutSeconds`
 * inner budget cannot stop it. Only the `runTimeoutSeconds` wall-clock kill
 * can unblock the race, which is precisely the behaviour we are asserting.
 * The runner exposes a `release()` hook so tests can let it resolve after
 * validating that the wall-clock kill fired first.
 */
function createUnresponsiveIsolatedRunner() {
  let observedAbortSignal: AbortSignal | undefined;
  const started = createDeferred<void>();
  let release!: () => void;
  const finished = new Promise<void>((resolve) => {
    release = resolve;
  });
  const runIsolatedAgentJob = vi.fn(async ({ abortSignal }) => {
    observedAbortSignal = abortSignal;
    started.resolve();
    // Ignore abort on purpose: this simulates a wedged agentTurn that swallows
    // the inner abort, which is exactly the failure mode `runTimeoutSeconds`
    // exists to bound.
    await finished;
    return { status: "ok" as const, summary: "wedged-but-released" };
  }) as CronServiceDeps["runIsolatedAgentJob"];

  return {
    runIsolatedAgentJob,
    getObservedAbortSignal: () => observedAbortSignal,
    waitForStart: () => started.promise,
    release,
  };
}

describe("cron service timer run-timeout registry-close behaviour", () => {
  let restoreStateDir: (() => void) | undefined;

  beforeEach(() => {
    restoreStateDir = undefined;
  });

  afterEach(() => {
    restoreStateDir?.();
    restoreStateDir = undefined;
  });

  it("closes the task-ledger row as timed_out when payload.timeoutSeconds fires", async () => {
    vi.useFakeTimers();
    try {
      const store = timerFixtures.makeStorePath();
      restoreStateDir = withStateDirForStorePath(store.storePath);

      const scheduledAt = Date.parse("2026-02-15T13:00:00.000Z");
      const cronJob = createIsolatedRegressionJob({
        id: "run-timeout-ledger-close",
        name: "run timeout ledger close",
        scheduledAt,
        schedule: { kind: "at", at: new Date(scheduledAt).toISOString() },
        payload: {
          kind: "agentTurn",
          message: "work",
          timeoutSeconds: FAST_TIMEOUT_SECONDS,
        },
        state: { nextRunAtMs: scheduledAt },
      });
      await writeCronJobs(store.storePath, [cronJob]);

      let now = scheduledAt;
      const abortAwareRunner = createAbortAwareIsolatedRunner();
      const state = createCronServiceState({
        cronEnabled: true,
        storePath: store.storePath,
        log: noopLogger,
        nowMs: () => now,
        enqueueSystemEvent: vi.fn(),
        requestHeartbeatNow: vi.fn(),
        runIsolatedAgentJob: vi.fn(async (params) => {
          const result = await abortAwareRunner.runIsolatedAgentJob(params);
          now += 5;
          return result;
        }),
      });

      const timerPromise = onTimer(state);
      await abortAwareRunner.waitForStart();
      await vi.advanceTimersByTimeAsync(Math.ceil(FAST_TIMEOUT_SECONDS * 1_000) + 10);
      await timerPromise;

      // Scheduler-side bookkeeping should have flipped to error with a timeout
      // error message (pre-existing behaviour).
      const job = state.store?.jobs.find((entry) => entry.id === "run-timeout-ledger-close");
      expect(job?.state.lastStatus).toBe("error");
      expect(job?.state.lastError).toContain("timed out");

      // Task ledger row must be closed in a terminal state (new behaviour).
      // Prior to this fix the `onTimer` error path returned without writing
      // the ledger, leaving the row in a stale `running` state for the audit
      // sweeper to later flag as `stale_running` / `lost`.
      const ledgerRow = findTaskByRunId(`cron:run-timeout-ledger-close:${scheduledAt}`);
      expect(ledgerRow).toBeDefined();
      expect(ledgerRow?.runtime).toBe("cron");
      expect(ledgerRow?.sourceId).toBe("run-timeout-ledger-close");
      // The registry-close path in executeJobCoreWithTimeout maps the
      // "timed out" error → `timed_out` terminal status so dashboards can
      // distinguish wall-clock kills from generic errors.
      expect(ledgerRow?.status).toBe("timed_out");
    } finally {
      vi.useRealTimers();
    }
  });

  it("fires the runTimeoutSeconds wall-clock kill when the inner abort is ignored", async () => {
    vi.useFakeTimers();
    try {
      const store = timerFixtures.makeStorePath();
      restoreStateDir = withStateDirForStorePath(store.storePath);

      const scheduledAt = Date.parse("2026-02-15T13:00:00.000Z");
      // timeoutSeconds (inner budget) > runTimeoutSeconds (wall-clock) so the
      // only way to unblock the race is the hard kill. If the hard kill
      // doesn't fire the test will hang on `await timerPromise` — this is
      // intentional: we want a test failure if the wall-clock code path
      // regresses.
      const cronJob = createIsolatedRegressionJob({
        id: "run-timeout-wall-clock",
        name: "run timeout wall clock",
        scheduledAt,
        schedule: { kind: "at", at: new Date(scheduledAt).toISOString() },
        payload: {
          kind: "agentTurn",
          message: "wedged work",
          timeoutSeconds: 30,
          runTimeoutSeconds: 1,
        },
        state: { nextRunAtMs: scheduledAt },
      });
      await writeCronJobs(store.storePath, [cronJob]);

      let now = scheduledAt;
      const unresponsiveRunner = createUnresponsiveIsolatedRunner();
      const state = createCronServiceState({
        cronEnabled: true,
        storePath: store.storePath,
        log: noopLogger,
        nowMs: () => now,
        enqueueSystemEvent: vi.fn(),
        requestHeartbeatNow: vi.fn(),
        runIsolatedAgentJob: vi.fn(async (params) => {
          const result = await unresponsiveRunner.runIsolatedAgentJob(params);
          now += 5;
          return result;
        }),
      });

      const timerPromise = onTimer(state);
      await unresponsiveRunner.waitForStart();

      // Drive fake time past runTimeoutSeconds (1s) but well under
      // timeoutSeconds (30s). The wall-clock timer should abort.
      await vi.advanceTimersByTimeAsync(1_100);
      // Let the abort handler unblock any queued microtasks, then drain the
      // runner so the enclosing Promise.race can observe the reject.
      await Promise.resolve();
      unresponsiveRunner.release();

      await timerPromise;

      // The abort signal was delivered even though the runner ignored it: this
      // demonstrates the wall-clock path invoked `runAbortController.abort()`.
      expect(unresponsiveRunner.getObservedAbortSignal()?.aborted).toBe(true);

      const job = state.store?.jobs.find((entry) => entry.id === "run-timeout-wall-clock");
      expect(job?.state.lastStatus).toBe("error");
      expect(job?.state.lastError).toContain("timed out");

      // The ledger row should still be closed terminally (same registry-close
      // path exercised for both inner timeout + wall-clock kill).
      const ledgerRow = findTaskByRunId(`cron:run-timeout-wall-clock:${scheduledAt}`);
      expect(ledgerRow).toBeDefined();
      expect(ledgerRow?.status).toBe("timed_out");
    } finally {
      vi.useRealTimers();
    }
  });
});
