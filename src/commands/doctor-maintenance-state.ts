import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { formatErrorMessage, toErrorObject } from "../infra/errors.js";
import { resolveGatewayStateOwnerPath } from "../infra/gateway-state-owner.js";
import { createSqliteReadOnlyWorkerScope } from "../infra/sqlite-readonly-worker.js";
import type { AgentDatabaseMigrationTarget } from "../infra/state-migrations.media-persistence-targets.js";
import {
  createUpdateDoctorDatabaseWriteCapture,
  DoctorMaintenanceRefusalError,
} from "../infra/update-doctor-result.js";
import {
  createOpenClawDatabaseMaintenanceScope,
  getOpenClawDatabaseMaintenanceScope,
  type OpenClawDatabaseMaintenanceScope,
} from "../state/openclaw-state-db-async-lifecycle.js";
import { closeOpenClawStateDatabaseByPathAsync } from "../state/openclaw-state-db-cache.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { admitOpenClawMaintenanceLiveAuthorityReads } from "../state/openclaw-state-maintenance-context.js";
import { assertDoctorAgentLeaseAdmission } from "./doctor-agent-lease-refusal.js";
import { acquireDoctorGatewayMaintenanceOwner } from "./doctor-maintenance-foreground.js";
import type { DoctorMaintenanceParams } from "./doctor-maintenance-types.js";
import { sanitizeDoctorNote } from "./doctor/emit-notes.js";

/** Database custody can change paths while stopped-service custody remains with Doctor. */
export function createDoctorMaintenanceState(options: {
  params: DoctorMaintenanceParams;
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
  deadline: () => number | undefined;
  assertCurrent?: () => void;
  assertReadCurrent: () => void;
  settle: <T>(operation: () => Promise<T>) => Promise<T>;
  warn: (message: string) => void;
}) {
  const { params, env, settle } = options;
  let resources: OpenClawDatabaseMaintenanceScope | undefined;
  let resourcesParent: OpenClawDatabaseMaintenanceScope | undefined;
  let inspections: ReturnType<typeof createSqliteReadOnlyWorkerScope> | undefined;
  let owner: Awaited<ReturnType<typeof acquireDoctorGatewayMaintenanceOwner>> | undefined;
  let selectedEnv = env;
  let captureAdmitted = false;
  let liveAuthorityReadsAdmitted = false;
  const capture = createUpdateDoctorDatabaseWriteCapture(params.databaseGenerations, {
    env,
    root: params.root ?? undefined,
    signal: options.signal,
    assertCurrent: () => owner!.assertCurrent(options.assertCurrent),
    warn: options.warn,
  });
  const closeResources = async (agentRoot?: string) => {
    const drainRoot = agentRoot ?? (resourcesParent ? undefined : resolveStateDir(selectedEnv));
    await resources?.close(
      drainRoot === undefined
        ? undefined
        : async () => {
            const { closeOpenClawAgentDatabasesAsync } =
              await import("../state/openclaw-agent-db-lifecycle.js");
            await closeOpenClawAgentDatabasesAsync(drainRoot);
          },
    );
    await inspections?.close();
    // Auth inspection readers are pooled separately from canonical agent handles.
    const { closeAuthProfileReadPool } =
      await import("../agents/auth-profiles/sqlite-read-pool.js");
    closeAuthProfileReadPool({ kind: "root", rootPath: resolveStateDir(selectedEnv) });
    resources = undefined;
    resourcesParent = undefined;
    inspections = undefined;
  };
  const settleCapture = async () => {
    if (owner && capture && captureAdmitted) {
      // Settle the original receipt keys before their canonical path can change.
      await settle(() => capture.settle());
      captureAdmitted = false;
    }
  };
  const enterResources = async (acquired: NonNullable<typeof owner>) => {
    // Transfer can retire the source owner before caller revalidation runs.
    owner = acquired;
    try {
      acquired.assertCurrent(options.assertCurrent);
      resourcesParent = getOpenClawDatabaseMaintenanceScope();
      resources = createOpenClawDatabaseMaintenanceScope({
        schemaMaintenance: true,
        assertDatabaseAccess: acquired.assertDatabaseAccess,
        assertOwnerCurrent: (access) => {
          acquired.assertCurrent(() => {
            options.assertCurrent?.();
            options.assertReadCurrent();
          }, access);
        },
      });
      if (liveAuthorityReadsAdmitted) {
        resources.run(() =>
          admitOpenClawMaintenanceLiveAuthorityReads(resolveOpenClawStateSqlitePath(selectedEnv)),
        );
      }
      inspections = createSqliteReadOnlyWorkerScope({
        signal: options.signal,
        deadlineOwnedByCaller: false,
      });
    } catch (error) {
      await acquired.release();
      owner = undefined;
      throw error;
    }
    if (capture && !captureAdmitted) {
      await settle(() => resources!.run(() => capture.admit()));
      captureAdmitted = true;
    }
  };
  const state = {
    get owner() {
      return owner;
    },
    get resources() {
      return resources;
    },
    get receipt() {
      return owner ? undefined : capture?.receipt;
    },
    run<T>(operation: () => T): T {
      // Cancellation stops read-only inspections; admitted writers retain their resource scope.
      return resources!.run(() => inspections!.run(operation));
    },
    async acquire(relocatedMaintenanceOwner?: typeof owner) {
      if (resources) {
        return;
      }
      const assertCurrent = relocatedMaintenanceOwner
        ? () => relocatedMaintenanceOwner.assertCurrent(options.assertCurrent)
        : options.assertCurrent;
      assertCurrent?.();
      const acquired = await acquireDoctorGatewayMaintenanceOwner(
        path.resolve(resolveOpenClawStateSqlitePath(selectedEnv)),
        selectedEnv,
        {
          ...params,
          assertCurrent,
          deadlineMs: options.deadline(),
          relocatedMaintenanceOwner,
        },
      );
      await enterResources(acquired);
    },
    async prepareRepair() {
      const beforeStateMutation = params.beforeStateMutation;
      if (beforeStateMutation) {
        await resources!.run(() =>
          beforeStateMutation({ env: selectedEnv, signal: options.signal }),
        );
        resources!.assertAdmission();
      }
      resources!.run(() =>
        admitOpenClawMaintenanceLiveAuthorityReads(resolveOpenClawStateSqlitePath(selectedEnv)),
      );
      liveAuthorityReadsAdmitted = true;
      const { resolvePendingLegacyStateDirMigrationPaths, prepareLegacyStateDirMigration } =
        await import("../infra/state-migrations.state-dir.js");
      const pending = resolvePendingLegacyStateDirMigrationPaths({ env });
      const sourceDir = resolveStateDir(env);
      if (!pending || path.resolve(sourceDir) !== path.resolve(pending.source)) {
        return;
      }
      owner!.assertCurrent(options.assertCurrent);
      const sourceDatabase = resolveOpenClawStateSqlitePath(env);
      // This runs before the long-lived Doctor callback. Include CLI/bootstrap
      // resources predating this scope before moving the owned state root.
      await closeResources(sourceDir);
      await closeOpenClawStateDatabaseByPathAsync(sourceDatabase);
      await settleCapture();
      const migration = owner!.run(() => {
        options.assertCurrent?.();
        owner!.assertCurrent();
        return prepareLegacyStateDirMigration({ env });
      });
      // Root rename, alias creation, and rollback are synchronous under the source
      // owner. Acquire the resulting root before surrendering source exclusion.
      selectedEnv = { ...env, OPENCLAW_STATE_DIR: migration?.stateDir ?? sourceDir };
      const changedOwnerPath =
        resolveGatewayStateOwnerPath(resolveOpenClawStateSqlitePath(selectedEnv)) !==
        owner!.lockPath;
      if (changedOwnerPath) {
        await state.acquire(owner);
      } else {
        await enterResources(owner!);
      }
      if (migration) {
        const result = migration.result;
        for (const change of [...result.changes, ...(result.notices ?? [])]) {
          params.runtime.log(sanitizeDoctorNote(change));
        }
        for (const warning of result.warnings) {
          options.warn(sanitizeDoctorNote(warning));
        }
      }
    },
    async repairSqliteNoCow(paths: readonly string[]) {
      if (paths.length === 0) {
        return { changes: [], warnings: [] };
      }
      const { repairDoctorSqliteNoCow } = await import("./doctor-sqlite-nocow.js");
      const stateDir = resolveStateDir(selectedEnv);
      const databasePath = resolveOpenClawStateSqlitePath(selectedEnv);
      options.assertCurrent?.();
      owner!.assertCurrent();
      await closeResources(stateDir);
      try {
        return await owner!.run(async () => {
          // Agent admission writes through shared state; retain that owner after drainage.
          await closeOpenClawStateDatabaseByPathAsync(databasePath);
          await assertDoctorAgentLeaseAdmission(selectedEnv);
          return repairDoctorSqliteNoCow({
            paths,
            stateDir,
            assertCurrent: () => {
              options.assertCurrent?.();
              owner!.assertCurrent();
              owner!.assertDatabaseAccess(databasePath);
            },
          });
        });
      } finally {
        // Restoration and update receipts use a fresh scope for the new file identity.
        await enterResources(owner!);
      }
    },
    async enableSqliteReclamation(agents: readonly AgentDatabaseMigrationTarget[]) {
      const { enableDoctorSqliteReclamation } = await import("./doctor-sqlite-reclamation.js");
      const { closeOpenClawAgentDatabaseByPathAsync } =
        await import("../state/openclaw-agent-db-lifecycle.js");
      const databasePath = resolveOpenClawStateSqlitePath(selectedEnv);
      options.signal.throwIfAborted();
      options.assertCurrent?.();
      owner!.assertCurrent();
      await resources!.run(async () => {
        for (const agent of agents) {
          await closeOpenClawAgentDatabaseByPathAsync(agent.path, agent.agentId);
        }
      });
      await closeResources();
      let operationError: Error | undefined;
      let result: { warnings: string[] } | undefined;
      try {
        result = await owner!.run(async () => {
          await closeOpenClawStateDatabaseByPathAsync(databasePath);
          await assertDoctorAgentLeaseAdmission(selectedEnv);
          return enableDoctorSqliteReclamation({
            env: selectedEnv,
            agents,
            signal: options.signal,
            assertCurrent: () => {
              options.assertCurrent?.();
              owner!.assertCurrent();
              owner!.assertDatabaseAccess(databasePath);
            },
            log: params.runtime.log,
          });
        });
      } catch (error) {
        operationError = toErrorObject(error, "SQLite reclamation failed.");
      }
      // Keep the original write-capture baseline until final maintenance release.
      try {
        await enterResources(owner!);
      } catch (error) {
        if (operationError !== undefined) {
          throw new AggregateError(
            [operationError, error],
            "SQLite reclamation and maintenance scope restoration failed.",
            { cause: error },
          );
        }
        throw error;
      }
      if (operationError !== undefined) {
        throw operationError;
      }
      return result!;
    },
    async cleanupRetainedRuntimes(inspectService: boolean) {
      const { captureRetainedNativeWorkerSource } =
        await import("../infra/worker-native-lifecycle.js");
      const { retireIdleOpenClawStateReadWorkers } =
        await import("../state/openclaw-state-read-worker.js");
      const { prepareRetainedUpdateRuntimeCleanup } = await import("./doctor-retained-runtime.js");
      options.assertCurrent?.();
      owner!.assertCurrent();
      const cleanup = await state.run(() =>
        prepareRetainedUpdateRuntimeCleanup(selectedEnv, { inspectService }),
      );
      const nativeSource = captureRetainedNativeWorkerSource();
      // This phase runs after the tracked Doctor callback has settled.
      let readersRetired: boolean;
      let brokerRetired: boolean;
      try {
        await closeResources();
        readersRetired = await retireIdleOpenClawStateReadWorkers(nativeSource);
        brokerRetired = await nativeSource.retireIdleBroker();
      } catch (cause) {
        throw new DoctorMaintenanceRefusalError(
          `Doctor inspection resource cleanup failed: ${formatErrorMessage(cause)}. Resolve this cleanup failure before restarting the Gateway or rerunning openclaw doctor --fix.`,
          { kind: "data-at-risk", reason: "active-mutation" },
          { cause },
        );
      }
      try {
        await owner!.run(() =>
          cleanup(true, {
            assertCurrent() {
              options.assertCurrent?.();
              owner!.assertCurrent();
              owner!.assertDatabaseAccess(resolveOpenClawStateSqlitePath(selectedEnv));
            },
            assertResourcesSettled() {
              // Worker threads share this PID and are invisible to the process census.
              if (!readersRetired || !brokerRetired || nativeSource.hasActiveWorkers) {
                throw new Error(
                  `independent native work in this process (PID: ${process.pid}); let these holders finish, then rerun openclaw doctor --fix`,
                );
              }
            },
          }),
        );
      } finally {
        await enterResources(owner!);
      }
    },
    async release() {
      await closeResources();
      await settleCapture();
      await owner?.release();
      owner = undefined;
    },
  };
  return state;
}
