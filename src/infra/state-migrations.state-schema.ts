import { existsSync } from "node:fs";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import { resolveLegacyCronDefaultStoreKey } from "../state/openclaw-state-db-cron-identity-migration.js";
import {
  openOpenClawStateDatabaseForDoctor,
  prepareOpenClawStateDatabaseSchema,
} from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { getOpenClawDatabaseMaintenanceScope } from "../state/openclaw-state-maintenance-context.js";
import { SCHEMA_RECOVERY } from "./schema-migration-diagnostics.js";
import type {
  LegacyStateMigrationEndpoint,
  LegacyStateMigrationMode,
  LegacyStateMigrationStep,
} from "./state-migrations.types.js";
import { hasUpdateDoctorMigrationCapture } from "./update-doctor-migration-context.js";

export function createStateSchemaMigrationStep(params: {
  stateDir: string;
  env: NodeJS.ProcessEnv;
  mode: LegacyStateMigrationMode | "doctor-preparation";
  requiredness: LegacyStateMigrationStep["requiredness"];
  integrityCheck?: "quick" | "full";
}): LegacyStateMigrationStep {
  const stateEnv = { ...params.env, OPENCLAW_STATE_DIR: params.stateDir };
  // Capture selection before pinning physical paths for quarantine and permissions.
  const legacyCronDefaultStoreKey = resolveLegacyCronDefaultStoreKey(
    params.env.OPENCLAW_STATE_DIR?.trim() || params.env.OPENCLAW_CONFIG_PATH?.trim()
      ? params.env
      : stateEnv,
  );
  const database: LegacyStateMigrationEndpoint = {
    kind: "sqlite",
    path: resolveOpenClawStateSqlitePath(stateEnv),
  };
  return {
    id: "state-schema",
    phase: "shared",
    source: [database],
    target: [database],
    requiredness: params.requiredness,
    reversibility: "checkpoint-required",
    run: async () => {
      const result = await prepareOpenClawStateDatabaseSchema(
        { env: stateEnv, legacyCronDefaultStoreKey, integrityCheck: params.integrityCheck },
        params.mode,
      );
      if (result.changes.length > 0) {
        // Schema repair can expose install records hidden from pre-upgrade discovery.
        clearPluginMetadataLifecycleCaches();
      }
      if (result.warnings.length > 0) {
        return { ...result, notices: [SCHEMA_RECOVERY] };
      }
      const maintenance = getOpenClawDatabaseMaintenanceScope();
      if (
        maintenance?.ownsSchemaMaintenance &&
        hasUpdateDoctorMigrationCapture() &&
        existsSync(database.path)
      ) {
        // Schema maintenance retired the captured Doctor writer that prepareDoctorRuntimeChecks
        // opened. Later steps write through the shared-state worker, whose connection stays open
        // for the maintenance scope, and a later synchronous writer could then not take the
        // capture's exclusive access. Reopen the writer while no other connection holds it.
        await openOpenClawStateDatabaseForDoctor({ env: stateEnv });
        maintenance.assertAdmission();
      }
      return result;
    },
  };
}
