import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { withUpdateCommandExecutor } from "../cli/update-cli/update-command-executor.js";
import * as processGroups from "../process/supervisor/service-child-group-ownership.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { useStateDatabaseTempDirs } from "../test-utils/state-database-temp-dirs.js";
import { isContainerEnvironment } from "./container-environment.js";
import { withDatabaseEngineSelection } from "./database-engine/context.js";
import { resolveDatabaseFamilyEngines } from "./database-engine/registry.js";
import { prepareStagedPackageInstall } from "./package-update-lifecycle.js";
import { createNpmTarget } from "./package-update-steps.test-support.js";
import { holdForeignWriter } from "./sqlite-worker-shared-state-admission.test-support.js";
import { UPDATE_RUN_ID_ENV } from "./update-control-plane-sentinel.js";
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
afterEach(() => {
  admission.created = admission.beforeGrant = undefined;
  vi.unstubAllEnvs();
});
const tempDirs = useStateDatabaseTempDirs();
function fixture(input: Parameters<typeof updateRunFixture>[1]) {
  const options = { env: { OPENCLAW_STATE_DIR: tempDirs.make("update-reconciliation-") } };
  const run = updateRunFixture(options, input);
  return {
    ...run,
    options,
    reconcile: (
      selection: Parameters<typeof reconcileAbandonedUpdateRunsAsync>[0] = {},
      snapshot?: true,
    ) => reconcileAbandonedUpdateRunsAsync(selection, { ...options, snapshot }),
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
  expect(await readUpdateRunStatus()).toMatchObject({
    activeRun: { runId: run.id, status: "running", phase: "activating" },
    abandonedRun: {
      runId: run.id,
      rule: "inactive-driver-dead",
    },
  });
  expect(await run.readAsync()).toEqual(run.recorded);
  await run.reconcile({ explicit: true });
  expect(await run.readAsync()).toMatchObject({
    status: "failed",
    reason: "abandoned",
    phase: "finished",
    finishedAtMs: expect.any(Number),
  });
});
it.each([
  { pruned: false, repair: false },
  { pruned: true, repair: false },
  { pruned: false, repair: true },
])(
  "recovers a killed validating handoff (pruned helper: $pruned, repair custody: $repair)",
  async ({ pruned, repair }) => {
    const helper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });
    await once(helper, "spawn");
    const parent = readUpdateRunDriver()!;
    const driver = readUpdateRunDriver(helper.pid)!;
    const run = fixture({
      trigger: "cli",
      origin: {
        driver: pruned ? undefined : driver,
        previousDrivers: [parent],
        managedHandoff: { parent, helper: driver },
      },
    });
    const env = {
      ...process.env,
      ...run.options.env,
      OPENCLAW_UPDATE_RUN_HANDOFF: "1",
      [UPDATE_RUN_ID_ENV]: run.id,
    };
    try {
      const staged = await prepareStagedPackageInstall(
        createNpmTarget(path.join(env.OPENCLAW_STATE_DIR, "lib", "node_modules")),
        "openclaw",
        undefined,
        env,
      );
      const stage = staged.stagedInstall!;
      run.phase("validating");
      await closeOpenClawStateDatabaseAsync();
      vi.stubEnv("OPENCLAW_STATE_DIR", env.OPENCLAW_STATE_DIR);
      expect(await readUpdateRunStatus()).toMatchObject({
        activeRun: { runId: run.id, status: "running" },
      });
      const exited = once(helper, "exit");
      helper.kill("SIGKILL");
      await exited;
      if (repair) {
        await closeOpenClawStateDatabaseAsync();
      }
      // Native census contracts cover the host-wide table. This worker fixture
      // owns only its exited helper; unrelated host processes may be unreadable.
      vi.spyOn(processGroups, "readProcessGroupMembers").mockImplementation(function* () {
        yield {
          pid: process.pid,
          pgid: process.pid,
          state: "S",
          command: { ppid: process.ppid, argv: [process.execPath] },
        };
      });
      if (repair) {
        await withUpdateCommandExecutor(run.id, async (executor) => {
          const repairOwnership = await executor.enter(env.OPENCLAW_STATE_DIR);
          await reconcileAbandonedUpdateRunsAsync(
            { explicit: true, runIds: [run.id] },
            { ...run.options, repairOwnership },
          );
        });
      }
      expect(await readUpdateRunStatus()).toMatchObject({
        lastRun: { runId: run.id, status: "failed", reason: "handoff-terminated" },
      });
      const steps = (await run.readAsync())?.steps;
      expect(steps?.find(({ step }) => step === "reconcile:abandoned")?.detail).toContain(
        "validating",
      );
      const retained = process.platform === "linux" && isContainerEnvironment();
      expect(fs.existsSync(stage.prefix), JSON.stringify(steps)).toBe(retained);
      expect(steps?.some(({ step }) => step === "warning:recovery-artifact-cleanup")).toBe(
        retained,
      );
    } finally {
      if (helper.exitCode === null && helper.signalCode === null) {
        const exited = once(helper, "exit");
        helper.kill("SIGKILL");
        await exited;
      }
    }
  },
);
it("settles expired legacy history through the history reader", async () => {
  const run = await expiredLegacyRun();
  const reconciled = (await run.history()).run;
  expect(reconciled).toMatchObject({
    runId: run.id,
    phase: "finished",
    status: "failed",
    reason: "legacy-driver-expired",
  });
  expect(await run.readAsync()).toEqual(reconciled);
});
it("rejects cancellation at commit instead of returning stale history", async () => {
  const run = await expiredLegacyRun();
  const before = await run.readAsync();
  const controller = new AbortController();
  const failure = new Error("fixture update owner canceled");
  admission.beforeGrant = (stage) => {
    if (stage === "commit") {
      controller.abort(failure);
    }
  };
  await expect(run.history(controller.signal)).rejects.toThrow(failure.message);
  expect(await run.readAsync()).toEqual(before);
});

it.each(["sqlite", "postgres"] as const)(
  "preserves history without current exclusive %s repair custody",
  async (engine) => {
    const driver = readUpdateRunDriver();
    expect(driver).toBeDefined();
    const run = fixture({
      trigger: "cli",
      origin: { driver: { ...driver!, host: "previous-mac.invalid" } },
    });
    const before = run.read();
    await closeOpenClawStateDatabaseAsync();
    const failure = new Error("fixture repair ownership lost");
    await withUpdateCommandExecutor(run.id, async (executor) => {
      const fence = await executor.enter(run.options.env.OPENCLAW_STATE_DIR);
      let current = true;
      admission.beforeGrant = (stage) => {
        if (stage === "commit") {
          current = false;
        }
      };
      const reconcile = () =>
        reconcileAbandonedUpdateRunsAsync(
          { explicit: true, runIds: [run.id] },
          {
            ...run.options,
            repairOwnership: {
              assertCurrent() {
                fence.assertCurrent();
                if (!current) {
                  throw failure;
                }
              },
            },
          },
        );
      if (engine === "postgres") {
        await withDatabaseEngineSelection(
          {
            effectiveEngines: resolveDatabaseFamilyEngines({ database: { engine } }),
            postgres: {
              connection: "postgresql://synthetic.invalid/unused",
              schemaPrefix: "synthetic",
            },
          },
          () =>
            expect(reconcile()).rejects.toThrow(
              "Local repair ownership cannot prove PostgreSQL update drivers inactive",
            ),
        );
      } else {
        await expect(reconcile()).rejects.toThrow(failure.message);
      }
    });
    expect(await run.readAsync()).toEqual(before);
  },
);
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
