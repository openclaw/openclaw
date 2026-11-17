import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { recordUpdateDatabaseWrites } from "../cli/update-cli/update-command-database-receipts.js";
import * as serviceMaintenance from "../cli/update-cli/update-command-service-maintenance.js";
import { createOpenClawDatabaseMaintenanceScope } from "../state/openclaw-state-db-async-lifecycle.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { getOpenClawDatabaseMaintenanceScope } from "../state/openclaw-state-maintenance-context.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { acquireGatewayLock } from "./gateway-lock.js";
import { readGatewayOwnerLease } from "./gateway-owner-lease.js";
import { stopSupervisedPredecessorGateway } from "./update-candidate-predecessor-stop.js";
import type { UpdateDatabaseBackup } from "./update-database-backup.js";
import { readUpdateDatabaseGenerations } from "./update-database-generations.js";
import { runUpdateSqliteMigration } from "./update-doctor-migration-attribution.js";
import { createUpdateDoctorDatabaseWriteCapture } from "./update-doctor-result.js";
import { createUpdateRun, getUpdateRun } from "./update-run-ledger.js";

afterEach(() => vi.restoreAllMocks());

// Real SQLite, Gateway owner-lease release, receipt publication and forward
// migration. Only the native service adapter is simulated; no listener is opened.
it
  .runIf(process.platform !== "win32")
  .each([
    "none",
    "predecessor release",
    "before custody",
    "under custody",
    "after receipt",
  ] as const)(
  "retains rollback safety through a predecessor stop receipt (%s)",
  async (interference) => {
    await withOpenClawTestState({ scenario: "minimal", applyEnv: true }, async ({ env }) => {
      const pathname = openOpenClawStateDatabase({ env }).path;
      const { runId } = createUpdateRun({ trigger: "control-ui" }, { env });
      await closeOpenClawStateDatabaseAsync();
      const predecessor =
        interference === "predecessor release"
          ? await acquireGatewayLock({
              env,
              allowInTests: true,
              listenerMode: "supervised",
              supervisor: { kind: "systemd", name: "fixture.service" },
              // Lease metadata only; this test opens no listener.
              port: 43821,
            })
          : undefined;
      try {
        if (predecessor) {
          expect(readGatewayOwnerLease({ env, current: true })?.state).toBe("live");
        }
        const generations = readUpdateDatabaseGenerations([pathname]);
        const warnings: string[] = [];
        const unrelatedWrite = () => {
          using database = new DatabaseSync(pathname);
          database.exec("CREATE TABLE unrelated_write(value);");
        };
        vi.spyOn(
          serviceMaintenance,
          "maybeStopManagedServiceBeforeMutableUpdate",
        ).mockImplementation(async (options) => {
          options.assertCurrent?.();
          await predecessor?.release();
          if (interference === "before custody") {
            unrelatedWrite();
          }
          const stopped = {
            stopped: true,
            inspected: true,
            runtimeInspected: true,
            running: false,
            servicePid: 631,
            serviceManagerUid: 1000,
            stoppedAtMs: 7,
            serviceUpdateVerdict: {
              kind: "owned" as const,
              root: process.cwd(),
              fingerprint: "sealed",
              refreshDefinition: false,
            },
          };
          options.onStopped?.(stopped);
          return stopped;
        });
        if (interference === "under custody") {
          const ledger = await import("./update-run-ledger.js");
          const record = ledger.recordUpdateRunStep;
          vi.spyOn(ledger, "recordUpdateRunStep").mockImplementationOnce((...args) => {
            expect(getOpenClawDatabaseMaintenanceScope()?.ownsSchemaMaintenance).toBe(true);
            unrelatedWrite();
            return record(...args);
          });
        }
        const capture = createUpdateDoctorDatabaseWriteCapture(generations, {
          env,
          signal: new AbortController().signal,
          warn: (message) => warnings.push(message),
        })!;
        await capture.admit();
        const preparing = stopSupervisedPredecessorGateway(
          { runId, repair: true },
          { root: process.cwd(), assertCurrent() {}, warn: vi.fn(), databaseWriteCapture: capture },
        );
        const preCustodyDrift =
          interference === "predecessor release" || interference === "before custody";
        if (interference === "under custody") {
          await expect(preparing).rejects.toThrow("source changed after update capture");
          await capture.settle();
        } else {
          expect(await preparing).toBe(true);
          await closeOpenClawStateDatabaseAsync();
          expect(warnings).toEqual(
            preCustodyDrift
              ? [
                  "Captured SQLite databases changed while stopping the predecessor Gateway before maintenance custody; continuing Doctor with current state, but automatic database restoration is unavailable for this update.",
                ]
              : [],
          );
          if (interference === "after receipt") {
            unrelatedWrite();
          }
          const resources = createOpenClawDatabaseMaintenanceScope({
            schemaMaintenance: true,
            assertOwnerCurrent() {},
            assertDatabaseAccess() {},
          });
          try {
            await capture.admit();
            resources.run(() =>
              capture.run(() => {
                using database = new DatabaseSync(pathname);
                const migrateCaptured = () =>
                  runUpdateSqliteMigration(database, pathname, () =>
                    database.exec("CREATE TABLE predecessor_repaired(value);"),
                  );
                if (interference === "after receipt") {
                  expect(migrateCaptured).toThrow("source changed after update capture");
                } else {
                  migrateCaptured();
                  expect(
                    database.prepare("SELECT count(*) AS count FROM predecessor_repaired").get(),
                  ).toEqual({ count: 0 });
                }
              }),
            );
          } finally {
            await resources.close();
          }
          await capture.settle();
          expect(capture.receipt).toMatchObject({
            unchanged: interference === "none",
            fromGenerations: generations,
          });
        }
        const backup: UpdateDatabaseBackup = {
          directory: "synthetic-backup",
          databases: [],
          missingPaths: [],
          sourcePaths: [pathname],
          sourceGenerations: generations,
          warnings: [],
        };
        recordUpdateDatabaseWrites(backup, capture.receipt, { name: "openclaw doctor" });
        expect(backup.restoreRefusal).toBe(
          interference === "none"
            ? undefined
            : "databases changed after snapshot capture; the writer is unknown",
        );
        expect(getUpdateRun(runId, { env })?.steps).toContainEqual(
          expect.objectContaining({
            step: "finalize:predecessor-stop:7:1000:631:sealed",
            status: "completed",
          }),
        );
      } finally {
        await predecessor?.release();
        await closeOpenClawStateDatabaseAsync();
      }
    });
  },
);
