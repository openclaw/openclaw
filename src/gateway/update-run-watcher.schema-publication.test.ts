import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { SqlConnection } from "../infra/sql-connection.js";
import { createGatewayUpdateLifecycle } from "../infra/update-check-lifecycle.js";
import { createUpdateRun, finishUpdateRun } from "../infra/update-run-ledger.js";
import { reconcileUpdateRunsInNativeKernelForTest } from "../infra/update-run-reconciliation.test-support.js";
import { createDeferredCore } from "../shared/deferred.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../state/openclaw-state-db-contract.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  reconcileOpenClawStateSchemaPublication,
} from "../state/openclaw-state-db.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import type { GatewayBroadcastFn } from "./server-broadcast-types.js";
import { startUpdateRunWatcher, wakeUpdateRunWatcher } from "./update-run-watcher.js";

vi.mock("./update-run-notice.runtime.js", () => ({ notifyUpdateRunPhase: vi.fn() }));
// Notification transport must not reopen the database or introduce a real worker clock here.
vi.mock("./server-update-sentinel.js", async (original) => ({
  ...(await original<typeof import("./server-update-sentinel.js")>()),
  refreshLatestUpdateRestartSentinel: async () => null,
}));
// Publication deadlines share the fixture clock; worker transport is covered separately.
vi.mock("../state/openclaw-state-schema-publication.async.js", async (original) => ({
  ...(await original<typeof import("../state/openclaw-state-schema-publication.async.js")>()),
  reconcileOpenClawStateSchemaPublicationAsync: async (
    ...args: Parameters<typeof reconcileOpenClawStateSchemaPublication>
  ) => reconcileOpenClawStateSchemaPublication(...args),
}));
vi.mock("../infra/update-run-reconciliation.js", async (original) => ({
  ...(await original<typeof import("../infra/update-run-reconciliation.js")>()),
  reconcileAbandonedUpdateRunsAsync: async (
    ...args: Parameters<typeof reconcileUpdateRunsInNativeKernelForTest>
  ) => reconcileUpdateRunsInNativeKernelForTest(...args),
}));
vi.mock("../infra/update-run-reader.js", async (original) => {
  const actual = await original<typeof import("../infra/update-run-reader.js")>();
  return {
    ...actual,
    getUpdateRunAsync: async (...args: Parameters<typeof actual.getUpdateRun>) =>
      actual.getUpdateRun(...args),
    listUpdateRunsAsync: async (...args: Parameters<typeof actual.listUpdateRuns>) =>
      actual.listUpdateRuns(...args),
  };
});
vi.mock("../infra/update-run-interruption.js", () => ({
  // Publication and shutdown remain responsive during interrupted-update verification.
  reconcileInterruptedUpdateRuns: async ({ signal }: { signal: AbortSignal }) => {
    await new Promise<void>((resolve) => {
      signal.addEventListener("abort", () => resolve(), { once: true });
    });
    return [];
  },
}));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const now = Date.parse("2026-09-07T12:00:00Z");
const graceMs = 5 * 60_000;
let watcher: ReturnType<typeof startUpdateRunWatcher> | undefined;
let clock: ReturnType<typeof createGatewaySchedulerClock>;
let scheduler: ReturnType<typeof createTestGatewayScheduler>;
let lifecycle: ReturnType<typeof createGatewayUpdateLifecycle>;

beforeEach(() => {
  clock = createGatewaySchedulerClock(now);
  scheduler = createTestGatewayScheduler(clock.clock);
  lifecycle = createGatewayUpdateLifecycle(scheduler);
  vi.spyOn(Date, "now").mockImplementation(clock.clock.now);
  vi.stubEnv("OPENCLAW_STATE_DIR", tempDirs.make("openclaw-watcher-publication-"));
});
afterEach(async () => {
  await watcher?.stop();
  await lifecycle.stop();
  watcher = undefined;
  closeOpenClawStateDatabaseForTest();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await scheduler.stop();
});

async function startWatcher({ running = false, elapsedMs = 0 } = {}) {
  const { db } = openOpenClawStateDatabase();
  const run = createUpdateRun({ trigger: "cli", before: { version: "2026.9.2" } });
  // The runner tests cover the v15 rewrite; this fixture starts at its committed result.
  db.prepare(`INSERT INTO config_machine_state (state_key, value_json, updated_at_ms)
    VALUES ('state.schema.contentVersion', ?, ?)`).run(String(OPENCLAW_STATE_SCHEMA_VERSION), now);
  db.exec(`PRAGMA user_version = 15;
    UPDATE schema_meta SET schema_version = 15 WHERE meta_key = 'primary';`);
  closeOpenClawStateDatabaseForTest();
  const reopened = openOpenClawStateDatabase().db;
  if (!running) {
    finishUpdateRun(run.runId, { status: "succeeded" });
  }
  clock.setTime(now + elapsedMs);
  const log = { warn: vi.fn() };
  const observed = createDeferredCore();
  const broadcast = vi.fn<GatewayBroadcastFn>(() => observed.resolve());
  const scheduled = nextSchedule();
  watcher = startUpdateRunWatcher({ lifecycle, broadcast, log });
  await scheduled;
  if (running) {
    await observed.promise;
    expect(broadcast).toHaveBeenCalledWith(
      "update.run.changed",
      expect.objectContaining({ runId: run.runId }),
    );
  }
  return { db: reopened, runId: run.runId, log, broadcast };
}

function expectVersion(db: SqlConnection, version: number) {
  // Read the held SQLite connection directly: opening a new runner would hide a broken timer.
  expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: version });
  expect(
    db.prepare("SELECT schema_version FROM schema_meta WHERE meta_key = 'primary'").get(),
  ).toEqual({ schema_version: version });
}

async function expectPublicationAt(db: SqlConnection, remainingMs: number) {
  await clock.advanceBy(remainingMs - 1);
  expectVersion(db, 15);
  await clock.advanceBy(1);
  expectVersion(db, OPENCLAW_STATE_SCHEMA_VERSION);
}

function nextSchedule(atMs?: number) {
  const scheduled = createDeferredCore();
  const arm = clock.clock.arm;
  const scheduling = vi.spyOn(clock.clock, "arm").mockImplementation((run, delayMs) => {
    const cancel = arm(run, delayMs);
    if (atMs === undefined || clock.clock.now() + delayMs === atMs) {
      scheduling.mockRestore();
      scheduled.resolve();
    }
    return cancel;
  });
  return scheduled.promise;
}

describe("Gateway schema publication timer", () => {
  it("anchors a restarted watcher's timer to the existing terminal timestamp", async () => {
    const { db, log } = await startWatcher({ elapsedMs: 2 * 60_000 });
    expectVersion(db, 15);
    await expectPublicationAt(db, 3 * 60_000);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("publishes after observing the old updater finish without another database open", async () => {
    const { db, runId, log, broadcast } = await startWatcher({ running: true });
    const terminalObserved = createDeferredCore();
    broadcast.mockImplementationOnce(() => terminalObserved.resolve());
    clock.setTime(now + 10_000);
    finishUpdateRun(runId, { status: "succeeded" });
    await clock.wake();
    await terminalObserved.promise;
    expect(broadcast).toHaveBeenLastCalledWith(
      "update.run.changed",
      expect.objectContaining({ runId, status: "succeeded" }),
    );
    await expectPublicationAt(db, graceMs);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("rechecks new running rows at the deadline and reschedules for their terminal grace", async () => {
    const { db, log } = await startWatcher();
    await clock.advanceBy(graceMs - 1);
    const next = createUpdateRun({ trigger: "cli", before: { version: "2026.9.2" } });
    // No wake: the already scheduled timer must discover this new driver itself.
    await clock.advanceBy(1);
    expectVersion(db, 15);
    const publicationScheduled = nextSchedule(clock.clock.now() + graceMs);
    wakeUpdateRunWatcher();
    finishUpdateRun(next.runId, { status: "succeeded" });
    await publicationScheduled;
    await expectPublicationAt(db, graceMs);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("cancels pending publication when the watcher stops", async () => {
    const { db, log } = await startWatcher();
    await watcher?.stop();
    wakeUpdateRunWatcher();
    await clock.advanceBy(graceMs + 1);
    expectVersion(db, 15);
    expect(log.warn).not.toHaveBeenCalled();
  });
});
