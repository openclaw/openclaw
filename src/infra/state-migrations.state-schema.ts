import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import { resolveLegacyCronDefaultStoreKey } from "../state/openclaw-state-db-cron-identity-migration.js";
import { prepareOpenClawStateDatabaseSchema } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { SCHEMA_RECOVERY } from "./schema-migration-diagnostics.js";
import type {
  LegacyStateMigrationEndpoint,
  LegacyStateMigrationMode,
  LegacyStateMigrationStep,
} from "./state-migrations.types.js";

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
      return result.warnings.length > 0 ? { ...result, notices: [SCHEMA_RECOVERY] } : result;
    },
  };
}
