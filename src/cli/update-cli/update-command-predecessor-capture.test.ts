import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { createFixtureLifetime } from "../../../test/helpers/fixture-lifetime.js";
import { createDoctorMaintenanceState } from "../../commands/doctor-maintenance-state.js";
import {
  createMockGatewayService,
  mockSystemAccountHome,
} from "../../daemon/service.test-helpers.js";
import { openNodeSqliteDatabase } from "../../infra/node-sqlite.js";
import * as processAncestry from "../../infra/restart-stale-pids.js";
import {
  createUpdateDatabaseBackup,
  type UpdateDatabaseBackup,
} from "../../infra/update-database-backup.js";
import { restoreUpdateDatabaseBackup } from "../../infra/update-database-restore.js";
import { withUpdateDoctorPredecessor } from "../../infra/update-doctor-predecessor.js";
import { createUpdateRun, getUpdateRun } from "../../infra/update-run-ledger.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
  repairOpenClawStateDatabaseSchema,
} from "../../state/openclaw-state-db.js";
import { STATE_SCHEMA_13_TO_12_DOWNGRADE_SQL } from "../../state/openclaw-state-schema-v13-widerow.test-support.js";
import {
  addPreCutoverClientCredentialTablesForTest,
  restorePreTemplateStateIdentifiersForTest,
} from "../../state/openclaw-state-schema.test-support.js";
import { mockProcessPlatform } from "../../test-utils/vitest-spies.js";
import { prepareCandidateAuthorityRuntime } from "./update-command-candidate-authority.test-support.js";
import { recordUpdateDatabaseWrites } from "./update-command-database-receipts.js";
import { withServiceHome } from "./update-command-service-home.test-support.js";

const runtimeFixture = createFixtureLifetime();
let candidateRoot: string;
beforeAll(async () => {
  const runtime = await runtimeFixture.run(() =>
    prepareCandidateAuthorityRuntime(runtimeFixture.createTempDir("predecessor-candidate-")),
  );
  candidateRoot = fileURLToPath(new URL("../../", runtime.worker));
});
afterAll(() => runtimeFixture.cleanup());

const mocks = vi.hoisted(() => ({ service: vi.fn() }));
vi.mock("../../daemon/service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../daemon/service.js")>()),
  resolveGatewayService: mocks.service,
}));
vi.mock("../../daemon/service-process-membership.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../daemon/service-process-membership.js")>()),
  inspectServiceProcessMembershipSync: vi.fn(() => "outside"),
}));
afterEach(() => vi.restoreAllMocks());

// Only the native service adapter is simulated: capture, ledger worker, physical
// maintenance, v12 migration, receipt settlement, and rollback use their real owners.
it.each(["respawning", "unloaded", "disabled", "independent", "before-receipt"] as const)(
  "retains original rollback capture through predecessor stop and migration: %s",
  (scenario) =>
    withServiceHome(async (home) => {
      mockSystemAccountHome();
      vi.spyOn(processAncestry, "inspectSelfAndAncestorPidsSync").mockReturnValue({
        pids: new Set([process.pid, process.ppid, 1]),
        complete: true,
      });
      openOpenClawStateDatabase();
      const runId = createUpdateRun({ trigger: "cli" }).runId;
      await closeOpenClawStateDatabaseAsync();
      const databasePath = path.join(home, ".openclaw", "state", "openclaw.sqlite");
      {
        using db = openNodeSqliteDatabase(databasePath);
        restorePreTemplateStateIdentifiersForTest(db);
        addPreCutoverClientCredentialTablesForTest(db);
        db.exec(STATE_SCHEMA_13_TO_12_DOWNGRADE_SQL);
      }
      const backup: UpdateDatabaseBackup = await createUpdateDatabaseBackup({
        backupRoot: path.join(home, "capture"),
        stateDir: path.join(home, ".openclaw"),
        config: {},
        env: process.env,
      });
      const original = { ...backup.sourceGenerations };
      const warnings: string[] = [];
      let loaded = scenario !== "unloaded";
      const stops =
        scenario === "respawning" || scenario === "independent" || scenario === "before-receipt";
      const service = createMockGatewayService({
        readCommand: async () => ({
          programArguments: [process.execPath, path.join(candidateRoot, "openclaw.mjs"), "gateway"],
          environment: { HOME: home },
        }),
        readRuntime: async () => ({ status: "stopped" }),
        isLoaded: async () => loaded,
        isEnabled: async () => scenario !== "disabled",
        stop: vi.fn(async () => {
          loaded = false;
          platform.mockRestore();
          if (scenario === "before-receipt") {
            using db = openNodeSqliteDatabase(databasePath);
            db.exec("CREATE TABLE independent_writer(value TEXT)");
          }
        }),
      });
      mocks.service.mockReturnValue(service);
      const platform = mockProcessPlatform("darwin");
      try {
        const run = () =>
          withUpdateDoctorPredecessor(
            { runId, repair: true, databaseGenerations: original },
            { root: candidateRoot, assertCurrent() {}, warn: (message) => warnings.push(message) },
            async (capture) => {
              platform.mockRestore();
              expect(service.stop, warnings.join("\n")).toHaveBeenCalledTimes(stops ? 1 : 0);
              expect(
                getUpdateRun(runId)?.steps.some((step) =>
                  step.step.startsWith("finalize:predecessor-stop:"),
                ),
              ).toBe(stops);
              await closeOpenClawStateDatabaseAsync();
              if (scenario === "independent") {
                using db = openNodeSqliteDatabase(databasePath);
                db.exec("CREATE TABLE independent_writer(value TEXT)");
              }
              const maintenance = await createDoctorMaintenanceState({
                params: {
                  root: candidateRoot,
                  options: { repair: true, nonInteractive: true },
                  runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
                  databaseGenerations: original,
                  databaseWriteCapture: capture,
                },
                env: process.env,
                signal: new AbortController().signal,
                deadline: () => undefined,
                assertReadCurrent() {},
                settle: (operation) => operation(),
                warn: (message) => warnings.push(message),
              });
              try {
                await maintenance.acquire();
                await maintenance.prepareRepair();
                const migrate = () =>
                  maintenance.run(() => repairOpenClawStateDatabaseSchema({ env: process.env }));
                if (scenario === "independent") {
                  expect(migrate).toThrow("source changed after update capture");
                } else {
                  const repaired = migrate();
                  expect(repaired.warnings).toEqual([]);
                  expect(repaired.changes).toContain("Consolidated shared state tables (v13)");
                }
              } finally {
                expect(await maintenance.release()).toBeUndefined();
              }
              if (scenario !== "independent") {
                expect(warnings).toEqual([]);
              }
              expect(maintenance.receipt?.unchanged).toBe(scenario !== "independent");
              expect(maintenance.receipt?.fromGenerations).toEqual(original);
              recordUpdateDatabaseWrites(backup, maintenance.receipt, { name: "doctor" });
            },
          );
        if (scenario === "before-receipt") {
          await expect(run()).rejects.toThrow("source changed after update capture");
          return;
        }
        await run();
      } finally {
        platform.mockRestore();
        await closeOpenClawStateDatabaseAsync();
      }
      expect(backup.sourceGenerations).toEqual(original);
      if (scenario === "independent") {
        expect(backup.restoreRefusal).toContain("writer is unknown");
      } else {
        expect(backup.restoreRefusal).toBeUndefined();
        expect(backup.migration?.from).toEqual(original);
        expect(backup.migration?.to[databasePath]).not.toBe(original[databasePath]);
        expect(
          await restoreUpdateDatabaseBackup({
            backup,
            runId,
            env: process.env,
            assertCurrent() {},
            expectedGenerations: backup.migration?.to,
          }),
        ).not.toBeNull();
        using db = openNodeSqliteDatabase(databasePath, { readOnly: true });
        expect(
          db.prepare("SELECT schema_version FROM schema_meta WHERE meta_key = 'primary'").get()
            ?.schema_version,
        ).toBe(12);
      }
    }),
);
