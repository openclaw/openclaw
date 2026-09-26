import { beginDoctorMaintenance } from "../../commands/doctor-maintenance.js";
import { withConfigMutationLock } from "../../config/mutate.js";
import { resolveConfigPath } from "../../config/paths.js";
import { createSqliteReadOnlyWorkerScope } from "../../infra/sqlite-readonly-worker.js";
import {
  inspectUpdateRecoveryBackup,
  type UpdateRecoveryCaptureParams,
} from "../../infra/update-recovery-backup-inventory.js";
import { defaultRuntime } from "../../runtime.js";
import { closeOpenClawAgentDatabaseByPathAsync } from "../../state/openclaw-agent-db-lifecycle.js";
import {
  captureOpenClawDatabaseMaintenanceAdmission,
  getOpenClawDatabaseMaintenanceScope,
  type OpenClawDatabaseMaintenanceScope,
} from "../../state/openclaw-state-db-async-lifecycle.js";
import { closeOpenClawStateDatabaseByPathAsync } from "../../state/openclaw-state-db-cache.js";
import {
  withArtifactPreservingStateReads,
  withOpenClawStateDatabaseReadSnapshot,
} from "../../state/openclaw-state-db-readonly.js";
import { withOwnedManagedUpdateEnv } from "./update-command-service-env.js";

/** The original executor must already have joined children and stopped the service.
 * Maintenance fences Gateway admission while the worker snapshot owner captures SQLite
 * state. Config locks retain root/include writer custody through the entire operation,
 * and each effect boundary revalidates the captured source inventory. */
export async function withUpdateRecoverySourceCustody<T>(
  params: UpdateRecoveryCaptureParams & { env: NodeJS.ProcessEnv },
  operation: (custody: {
    maintenance: OpenClawDatabaseMaintenanceScope;
    assertCurrent: () => void;
  }) => Promise<T>,
): Promise<T> {
  const assertOriginal = params.assertOwned.bind(params);
  return withOwnedManagedUpdateEnv(params.env, async () => {
    assertOriginal();
    const owner = await beginDoctorMaintenance({
      root: null,
      options: { repair: true },
      runtime: defaultRuntime,
      runId: params.runId,
      assertCurrent: assertOriginal,
    });
    if (!owner) {
      throw new Error("Recovery requires stopped database maintenance.");
    }
    const readers = createSqliteReadOnlyWorkerScope();
    let outcome: { value: T } | { error: unknown };
    try {
      outcome = {
        value: await readers.run(() =>
          owner.run(async () => {
            const maintenance = getOpenClawDatabaseMaintenanceScope();
            if (!maintenance) {
              throw new Error("Recovery maintenance scope is unavailable.");
            }
            const assertMaintenance = captureOpenClawDatabaseMaintenanceAdmission(maintenance);
            const assertCurrent = () => {
              assertOriginal();
              assertMaintenance();
            };
            return withConfigMutationLock(
              { lockPath: resolveConfigPath(params.env), assertCurrent },
              async () => {
                const inspect = () =>
                  withArtifactPreservingStateReads(() =>
                    withOpenClawStateDatabaseReadSnapshot(() =>
                      inspectUpdateRecoveryBackup({ ...params, assertOwned: assertCurrent }),
                    ),
                  );
                let inspected: Awaited<ReturnType<typeof inspect>>;
                const locked = new Set([resolveConfigPath(params.env)]);
                const stabilize = async (): Promise<T> => {
                  inspected = await inspect();
                  assertCurrent();
                  const paths = [...inspected.configFiles].filter((p) => !locked.has(p)).toSorted();
                  const lockNext = (index: number): Promise<T> =>
                    index < paths.length
                      ? withConfigMutationLock({ lockPath: paths[index], assertCurrent }, () => {
                          locked.add(paths[index]!);
                          return lockNext(index + 1);
                        })
                      : stabilize();
                  // Discovery before an include's lock can see its old closure.
                  // Once every freshly discovered path is held, cooperating
                  // writers cannot introduce another unlocked nested include.
                  return paths.length ? lockNext(0) : exclude();
                };
                const exclude = async (): Promise<T> => {
                  // Agent closure can settle its lease in the global store. Drain all
                  // agent owners before sealing global writer admission.
                  for (const [pathname, database] of inspected.databaseOwners) {
                    if (database.role === "agent") {
                      await closeOpenClawAgentDatabaseByPathAsync(pathname, database.agentId);
                      assertCurrent();
                    }
                  }
                  for (const pathname of new Set([
                    ...inspected.databaseOwners.keys(),
                    ...inspected.files.filter((file) => file.sqlite).map((file) => file.pathname),
                  ])) {
                    assertCurrent();
                    await closeOpenClawStateDatabaseByPathAsync(pathname);
                    assertCurrent();
                  }
                  return operation({ maintenance, assertCurrent });
                };
                return stabilize();
              },
            );
          }),
        ),
      };
    } catch (error) {
      outcome = { error };
    }
    const failures: unknown[] = [];
    try {
      await readers.close();
    } catch (error) {
      failures.push(error);
    }
    try {
      await owner.release();
    } catch (error) {
      failures.push(error);
    }
    if (failures.length) {
      throw new AggregateError(
        "error" in outcome ? [outcome.error, ...failures] : failures,
        "Recovery and maintenance cleanup did not settle.",
      );
    }
    if ("error" in outcome) {
      throw outcome.error;
    }
    return outcome.value;
  });
}
