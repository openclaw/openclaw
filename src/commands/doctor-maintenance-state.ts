import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { resolveGatewayStateOwnerPath } from "../infra/gateway-state-owner.js";
import { createUpdateDoctorDatabaseWriteCapture } from "../infra/update-doctor-result.js";
import {
  createOpenClawDatabaseMaintenanceScope,
  type OpenClawDatabaseMaintenanceScope,
} from "../state/openclaw-state-db-async-lifecycle.js";
import { closeOpenClawStateDatabaseByPathAsync } from "../state/openclaw-state-db-cache.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
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
  let owner: Awaited<ReturnType<typeof acquireDoctorGatewayMaintenanceOwner>> | undefined;
  let selectedEnv = env;
  let captureAdmitted = false;
  const capture = createUpdateDoctorDatabaseWriteCapture(params.databaseGenerations, {
    env,
    root: params.root ?? undefined,
    signal: options.signal,
    assertCurrent: () => owner!.assertCurrent(options.assertCurrent),
    warn: options.warn,
  });
  const closeResources = async () => {
    await resources?.close();
    resources = undefined;
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
    } catch (error) {
      await acquired.release();
      owner = undefined;
      throw error;
    }
    if (capture) {
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
    async relocateLegacyRoot() {
      const { resolvePendingLegacyStateDirMigrationPaths, prepareLegacyStateDirMigration } =
        await import("../infra/state-migrations.state-dir.js");
      const pending = resolvePendingLegacyStateDirMigrationPaths({ env });
      const sourceDir = resolveStateDir(env);
      if (!pending || path.resolve(sourceDir) !== path.resolve(pending.source)) {
        return;
      }
      const { closeOpenClawAgentDatabasesAsync } =
        await import("../state/openclaw-agent-db-lifecycle.js");
      owner!.assertCurrent(options.assertCurrent);
      const sourceDatabase = resolveOpenClawStateSqlitePath(env);
      // This runs before the long-lived Doctor callback: closing its own tracked
      // callback would self-wait. Include CLI/bootstrap resources predating this scope.
      await closeResources();
      await closeOpenClawAgentDatabasesAsync(sourceDir);
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
        const result = await resources!.run(() => migration.complete());
        for (const change of [...result.changes, ...(result.notices ?? [])]) {
          params.runtime.log(sanitizeDoctorNote(change));
        }
        for (const warning of result.warnings) {
          options.warn(sanitizeDoctorNote(warning));
        }
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
