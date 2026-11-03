import { acquireDoctorGatewayMaintenanceOwner } from "../commands/doctor-maintenance-foreground.js";
import { defaultRuntime } from "../runtime.js";
import { getAsyncWorkSignal } from "../shared/async-work-scope.js";
import { createOpenClawDatabaseMaintenanceScope } from "../state/openclaw-state-db-async-lifecycle.js";
import { isStatePostgres } from "../state/openclaw-state-db-engine.js";
import {
  closeTrackedStateDatabase,
  openTrackedStateDatabase,
} from "../state/openclaw-state-db-handle.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import {
  acquireStateDatabaseSchemaLease,
  type StateDatabaseSchemaLease,
} from "./gateway-state-owner.js";
import { withStateDatabaseSchemaConnection } from "./state-database-maintenance.js";
import { stopSupervisedPredecessorGateway } from "./update-candidate-predecessor-stop.js";
import type { UpdateDatabaseGenerations } from "./update-database-generations.js";
import {
  runUpdateSqliteMigration,
  UpdateDoctorSourceChangedError,
} from "./update-doctor-migration-attribution.js";
import { createUpdateDoctorDatabaseWriteCapture } from "./update-doctor-result.js";
import { recordUpdateRunStep } from "./update-run-ledger.js";

/** One maintenance connection spans the required stop receipt and subsequent schema repair. */
export async function withUpdateDoctorPredecessor<T>(
  input: {
    runId: string;
    repair: boolean;
    databaseGenerations?: UpdateDatabaseGenerations;
    databasePluginOwners?: import("./database-engine/port-descriptor.js").DatabasePortPluginOwners;
  },
  params: {
    root: string;
    assertCurrent: () => void;
    serviceInspectionBudget?: () => number | undefined;
    warn: (message: string) => void;
  },
  operation: (capture: ReturnType<typeof createUpdateDoctorDatabaseWriteCapture>) => Promise<T>,
): Promise<T> {
  let owner: Awaited<ReturnType<typeof acquireDoctorGatewayMaintenanceOwner>> | undefined;
  let resources: ReturnType<typeof createOpenClawDatabaseMaintenanceScope> | undefined;
  let database: ReturnType<typeof openTrackedStateDatabase> | undefined;
  let schemaLease: StateDatabaseSchemaLease | undefined;
  let sourceRefusal: UpdateDoctorSourceChangedError | undefined;
  const pathname = resolveOpenClawStateSqlitePath();
  const closeDatabase = () => {
    if (database) {
      closeTrackedStateDatabase(database);
      database = undefined;
    }
  };
  const assertCurrent = () => {
    owner?.assertCurrent();
    params.assertCurrent();
  };
  const signal = getAsyncWorkSignal();
  const capture = createUpdateDoctorDatabaseWriteCapture(input.databaseGenerations, {
    env: process.env,
    root: params.root,
    signal: signal ?? new AbortController().signal,
    pluginOwners: input.databasePluginOwners,
    beforeSettle: closeDatabase,
    assertCurrent,
    warn: params.warn,
  });
  // Preserve the incoming pre-stop image; native stop is not permission to rebaseline it.
  await capture?.admit();
  const run = <R>(work: () => R): R =>
    owner && resources && database
      ? owner.run(() =>
          schemaLease!.run(() =>
            resources!.run(() => withStateDatabaseSchemaConnection(pathname, database!, work)),
          ),
        )
      : work();
  try {
    await stopSupervisedPredecessorGateway(input, {
      ...params,
      assertCurrent,
      ...(isStatePostgres()
        ? {}
        : {
            async recordReceipt(step) {
              owner = await acquireDoctorGatewayMaintenanceOwner(pathname, process.env, {
                options: { repair: true },
                runtime: defaultRuntime,
                assertCurrent: params.assertCurrent,
                signal,
                deadlineMs: (() => {
                  const remaining = params.serviceInspectionBudget?.();
                  return remaining === undefined ? undefined : performance.now() + remaining;
                })(),
              });
              owner.run(() => {
                schemaLease = acquireStateDatabaseSchemaLease(pathname);
                resources = createOpenClawDatabaseMaintenanceScope({
                  schemaMaintenance: true,
                  assertOwnerCurrent: assertCurrent,
                  assertDatabaseAccess: owner!.assertDatabaseAccess,
                });
                database = resources.run(() =>
                  openTrackedStateDatabase(pathname, {
                    existingOnly: true,
                    enableForeignKeyConstraints: false,
                  }),
                );
              });
              return run(() => {
                const write = () => {
                  assertCurrent();
                  const result = recordUpdateRunStep(input.runId, step, { env: process.env });
                  if (!result) {
                    throw new Error("Required predecessor stop receipt was not persisted.");
                  }
                  return result;
                };
                try {
                  const attributed = () =>
                    runUpdateSqliteMigration(database!, pathname, write, { oneShot: true });
                  return capture ? capture.run(attributed) : write();
                } catch (error) {
                  if (!(error instanceof UpdateDoctorSourceChangedError)) {
                    throw error;
                  }
                  // A refused preimage precedes the transaction: preserve the completed stop,
                  // but retain its refusal and do not continue into schema mutation or rollback.
                  sourceRefusal = error;
                  return write();
                }
              });
            },
          }),
    });
    assertCurrent();
    if (sourceRefusal) {
      throw sourceRefusal;
    }
    return await run(() => operation(capture));
  } finally {
    // Failed draining or native close retains custody: cleanup failure is not settlement.
    await resources?.close();
    closeDatabase();
    schemaLease?.release();
    await owner?.release();
  }
}
