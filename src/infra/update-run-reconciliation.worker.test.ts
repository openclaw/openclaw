import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { observeMainThreadSql } from "../test-utils/main-thread-sql-spies.test-support.js";
import { holdForeignWriter } from "./sqlite-worker-shared-state-admission.test-support.js";
import { createRetainedUpdateRecovery } from "./update-retained-recovery.test-support.js";
import {
  createUpdateRun,
  getUpdateRunAsync,
  getUpdateRunWithReconciliationAsync,
  reconcileAbandonedUpdateRunsAsync,
} from "./update-run-ledger.js";
import { loadUpdateRecovery } from "./update-run-recovery.js";

const admission = vi.hoisted(
  (): { created?: () => void; beforeGrant?: (stage: string) => void } => ({}),
);
vi.mock("./sqlite-worker-operation-admission.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./sqlite-worker-operation-admission.js")>();
  return {
    ...actual,
    createSqliteWorkerOperationAdmission: (
      ...args: Parameters<typeof actual.createSqliteWorkerOperationAdmission>
    ) => {
      admission.created?.();
      const [admit, attachment] = args;
      return actual.createSqliteWorkerOperationAdmission((request, grant) => {
        admission.beforeGrant?.(request.stage);
        admit(request, grant);
      }, attachment);
    },
  };
});

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    admission.created = undefined;
    admission.beforeGrant = undefined;
    await closeOpenClawStateDatabaseAsync();
    cleanup();
  }),
);

async function expiredLegacyRun() {
  const options = { env: { OPENCLAW_STATE_DIR: tempDirs.make("update-reconciliation-") } };
  const run = createUpdateRun({ trigger: "cli", before: { version: "2026.9.2" } }, options);
  const createdAtMs = Date.now() - 25 * 60 * 60_000;
  // Seed stored legacy history without changing the clocks used by database custody.
  openOpenClawStateDatabase(options)
    .db.prepare(
      "UPDATE update_runs SET created_at_ms = ?, updated_at_ms = ?, steps_json = ? WHERE run_id = ?",
    )
    .run(
      createdAtMs,
      createdAtMs,
      JSON.stringify([{ step: "requested", status: "in_progress", startedAtMs: createdAtMs }]),
      run.runId,
    );
  await closeOpenClawStateDatabaseAsync();

  return { options, run };
}

describe("update run reconciliation workers", () => {
  it.each(["history", "reconciliation"] as const)(
    "settles expired legacy history through %s without host SQLite",
    async (entryPoint) => {
      const { options, run } = await expiredLegacyRun();

      const sql = observeMainThreadSql();
      sql.calibrate();
      let nativeCalls = 0;
      try {
        const reconciled =
          entryPoint === "history"
            ? (await getUpdateRunWithReconciliationAsync(run.runId, options)).run
            : (await reconcileAbandonedUpdateRunsAsync({}, options))[0];
        expect(reconciled).toMatchObject({
          runId: run.runId,
          phase: "finished",
          status: "failed",
          reason: "legacy-driver-expired",
        });
        nativeCalls = sql.count();
      } finally {
        sql.restore();
      }
      expect(await getUpdateRunAsync(run.runId, options)).toMatchObject({
        status: "failed",
        reason: "legacy-driver-expired",
      });
      expect(nativeCalls).toBe(0);
    },
  );
  it("rejects cancellation at commit instead of returning stale history", async () => {
    const { options, run } = await expiredLegacyRun();
    const before = await getUpdateRunAsync(run.runId, options);
    const controller = new AbortController();
    const failure = new Error("fixture update owner canceled");
    const stages: string[] = [];
    admission.beforeGrant = (stage) => {
      stages.push(stage);
      if (stage === "commit") {
        controller.abort(failure);
      }
    };
    await expect(
      getUpdateRunWithReconciliationAsync(run.runId, { ...options, signal: controller.signal }),
    ).rejects.toThrow(failure.message);
    expect(stages).toEqual(["transaction", "commit"]);
    expect(await getUpdateRunAsync(run.runId, options)).toEqual(before);
  });

  it("retains recovery recorded after selection and before writer admission", async () => {
    const { options, run } = await expiredLegacyRun();
    const before = await getUpdateRunAsync(run.runId, options);
    const from = {
      root: options.env.OPENCLAW_STATE_DIR,
      nodePath: process.execPath,
      version: "2026.9.3",
      buildId: null,
    };
    let recovery: ReturnType<typeof createRetainedUpdateRecovery> | undefined;
    admission.created = () => {
      admission.created = undefined;
      recovery = createRetainedUpdateRecovery(
        { runId: run.runId, from, to: { ...from, version: "2026.9.4" } },
        options,
      );
    };
    expect(await reconcileAbandonedUpdateRunsAsync({}, options)).toEqual([]);
    expect(recovery).toBeDefined();
    expect(await getUpdateRunAsync(run.runId, options)).toEqual(before);
    expect(loadUpdateRecovery(run.runId, options)).toEqual(recovery);
  });

  it("allows the host event loop to release a contending native writer", async () => {
    const { options, run } = await expiredLegacyRun();
    const context = captureOpenClawStateWorkerContext(options);
    let foreign: ReturnType<typeof holdForeignWriter> | undefined;
    let releasedBeforeSettlement = false;
    let settled = false;
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
      const result = await reconcileAbandonedUpdateRunsAsync({}, options);
      settled = true;
      expect(releasedBeforeSettlement).toBe(true);
      expect(result).toMatchObject([
        { runId: run.runId, status: "failed", reason: "legacy-driver-expired" },
      ]);
      expect(await getUpdateRunAsync(run.runId, options)).toMatchObject({ status: "failed" });
    } finally {
      if (releaseTimer) {
        clearImmediate(releaseTimer);
      }
      foreign?.close();
    }
  });
});
