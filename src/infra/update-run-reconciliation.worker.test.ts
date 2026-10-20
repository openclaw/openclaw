import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { observeMainThreadSql } from "../test-utils/main-thread-sql-spies.test-support.js";
import { holdForeignWriter } from "./sqlite-worker-shared-state-admission.test-support.js";
import { createRetainedUpdateRecovery } from "./update-retained-recovery.test-support.js";
import { readUpdateRunDriver } from "./update-run-driver.js";
import { deadDriverFixture, updateRunFixture } from "./update-run-fixture.test-support.js";
import {
  adoptUpdateRun,
  getUpdateRun,
  getUpdateRunWithReconciliationAsync,
  reconcileAbandonedUpdateRunsAsync,
} from "./update-run-ledger.js";
import { loadUpdateRecovery } from "./update-run-recovery.js";
import { readUpdateRunStatus } from "./update-run-status.js";

const admission = vi.hoisted(
  (): { created?: () => void; beforeGrant?: (stage: string) => void } => ({}),
);
vi.mock("./sqlite-worker-operation-admission.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./sqlite-worker-operation-admission.js")>();
  return {
    ...actual,
    createSqliteWorkerOperationAdmission: (
      ...[admit, attachment]: Parameters<typeof actual.createSqliteWorkerOperationAdmission>
    ) => {
      admission.created?.();
      return actual.createSqliteWorkerOperationAdmission((request, grant) => {
        admission.beforeGrant?.(request.stage);
        admit(request, grant);
      }, attachment);
    },
  };
});
const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    admission.created = admission.beforeGrant = undefined;
    await closeOpenClawStateDatabaseAsync();
    cleanup();
  }),
);
function fixture(input: Parameters<typeof updateRunFixture>[1]) {
  const options = { env: { OPENCLAW_STATE_DIR: tempDirs.make("update-reconciliation-") } };
  const run = updateRunFixture(options, input);
  return {
    ...run,
    options,
    reconcile: (
      selection: Parameters<typeof reconcileAbandonedUpdateRunsAsync>[0] = {},
      snapshot?: true,
    ) =>
      reconcileAbandonedUpdateRunsAsync(selection, {
        ...options,
        ...(snapshot ? { snapshot } : {}),
      }),
    history: (signal?: AbortSignal) =>
      getUpdateRunWithReconciliationAsync(run.id, { ...options, signal }),
  };
}
async function expiredLegacyRun() {
  const run = fixture({ trigger: "cli", before: { version: "2026.9.2" } });
  const createdAtMs = Date.now() - 25 * 60 * 60_000;
  // Seed legacy history without changing the clocks used by database custody.
  openOpenClawStateDatabase(run.options)
    .db.prepare(
      "UPDATE update_runs SET created_at_ms = ?, updated_at_ms = ?, steps_json = ? WHERE run_id = ?",
    )
    .run(
      createdAtMs,
      createdAtMs,
      JSON.stringify([{ step: "requested", status: "in_progress", startedAtMs: createdAtMs }]),
      run.id,
    );
  await closeOpenClawStateDatabaseAsync();
  return run;
}
async function deadDriverRun() {
  const { driver, dead } = deadDriverFixture();
  const run = fixture({ trigger: "cli", origin: { driver: dead } });
  const recorded = run.phase("activating");
  await closeOpenClawStateDatabaseAsync();
  return { ...run, driver, recorded };
}

it("releases the live ledger when admission has no prior runs to reconcile", async () => {
  const run = fixture({ trigger: "cli", origin: { driver: readUpdateRunDriver() } });
  await expect(run.reconcile({ excludeRunId: run.id }, true)).resolves.toEqual([]);
  const recorded = run.phase("validating");
  closeOpenClawStateDatabaseForTest();
  const state = run.options.env.OPENCLAW_STATE_DIR;
  const displaced = path.join(state, "displaced.sqlite");
  fs.renameSync(path.join(state, "state", "openclaw.sqlite"), displaced);
  expect(getUpdateRun(run.id, { path: displaced })).toEqual(recorded);
});
it("preserves an owner that adopts dead-driver work before reconciliation commits", async () => {
  const run = await deadDriverRun();
  let adopted: ReturnType<typeof adoptUpdateRun> | undefined;
  admission.created = () => {
    admission.created = undefined;
    adopted = adoptUpdateRun(run.id, run.options);
  };
  await expect(run.reconcile({}, true)).resolves.toEqual([]);
  expect(adopted).toMatchObject({
    status: "running",
    phase: "activating",
    origin: { driver: run.driver },
  });
  expect(await run.readAsync()).toEqual(adopted);
});
it("status projects recent driver loss until explicit reconciliation", async () => {
  const run = await deadDriverRun();
  vi.stubEnv("OPENCLAW_STATE_DIR", run.options.env.OPENCLAW_STATE_DIR);
  try {
    expect(await readUpdateRunStatus()).toMatchObject({
      activeRun: { runId: run.id, status: "running", phase: "activating" },
      abandonedRun: {
        runId: run.id,
        rule: "inactive-driver-dead",
        nextAction: "Run `openclaw update repair` before retrying the update.",
      },
    });
    expect(await run.readAsync()).toEqual(run.recorded);
    await run.reconcile({ explicit: true });
    expect(await run.readAsync()).toMatchObject({
      status: "failed",
      phase: "finished",
      finishedAtMs: expect.any(Number),
    });
  } finally {
    vi.unstubAllEnvs();
  }
});
it.each(["history", "reconciliation"] as const)(
  "settles expired legacy history through %s without host SQLite",
  async (entryPoint) => {
    const run = await expiredLegacyRun();
    const sql = observeMainThreadSql();
    sql.calibrate();
    let nativeCalls = 0;
    try {
      const reconciled =
        entryPoint === "history" ? (await run.history()).run : (await run.reconcile())[0];
      expect(reconciled).toMatchObject({
        runId: run.id,
        phase: "finished",
        status: "failed",
        reason: "legacy-driver-expired",
      });
      nativeCalls = sql.count();
    } finally {
      sql.restore();
    }
    expect(await run.readAsync()).toMatchObject({
      status: "failed",
      reason: "legacy-driver-expired",
    });
    expect(nativeCalls).toBe(0);
  },
);
it("rejects cancellation at commit instead of returning stale history", async () => {
  const run = await expiredLegacyRun();
  const before = await run.readAsync();
  const controller = new AbortController();
  const failure = new Error("fixture update owner canceled");
  const stages: string[] = [];
  admission.beforeGrant = (stage) => {
    stages.push(stage);
    if (stage === "commit") {
      controller.abort(failure);
    }
  };
  await expect(run.history(controller.signal)).rejects.toThrow(failure.message);
  expect(stages).toEqual(["transaction", "commit"]);
  expect(await run.readAsync()).toEqual(before);
});
it("retains recovery recorded after selection and before writer admission", async () => {
  const run = await expiredLegacyRun();
  const before = await run.readAsync();
  const from = {
    root: run.options.env.OPENCLAW_STATE_DIR,
    nodePath: process.execPath,
    version: "2026.9.3",
    buildId: null,
  };
  let recovery: ReturnType<typeof createRetainedUpdateRecovery> | undefined;
  admission.created = () => {
    admission.created = undefined;
    recovery = createRetainedUpdateRecovery(
      { runId: run.id, from, to: { ...from, version: "2026.9.4" } },
      run.options,
    );
  };
  await expect(run.reconcile()).resolves.toEqual([]);
  expect(recovery).toBeDefined();
  expect(await run.readAsync()).toEqual(before);
  expect(loadUpdateRecovery(run.id, run.options)).toEqual(recovery);
});
it("allows the host event loop to release a contending native writer", async () => {
  const run = await expiredLegacyRun();
  const context = captureOpenClawStateWorkerContext(run.options);
  let foreign: ReturnType<typeof holdForeignWriter> | undefined;
  let releasedBeforeSettlement = false,
    settled = false;
  let releaseTimer: ReturnType<typeof setImmediate> | undefined;
  admission.created = () => {
    admission.created = undefined;
    foreign = holdForeignWriter(context);
    releaseTimer = setImmediate(() => {
      releasedBeforeSettlement = !settled;
      foreign?.release();
    });
  };
  try {
    const result = await run.reconcile();
    settled = true;
    expect(releasedBeforeSettlement).toBe(true);
    expect(result).toMatchObject([
      { runId: run.id, status: "failed", reason: "legacy-driver-expired" },
    ]);
    expect(await run.readAsync()).toMatchObject({ status: "failed" });
  } finally {
    if (releaseTimer) {
      clearImmediate(releaseTimer);
    }
    foreign?.close();
  }
});
