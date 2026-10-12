import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import { STATE_SCHEMA_MIGRATION_DESCRIPTIONS } from "../state/openclaw-state-db-contract.js";
import {
  prepareOpenClawStateDatabaseSchema,
  type OpenClawStateDatabaseSchemaMigration,
} from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import type {
  LegacyStateMigrationEndpoint,
  LegacyStateMigrationMode,
  LegacyStateMigrationStep,
} from "./state-migrations.types.js";

export function describeStateSchemaMigration(
  migration: OpenClawStateDatabaseSchemaMigration,
): string {
  return STATE_SCHEMA_MIGRATION_DESCRIPTIONS[migration.kind];
}

export function createStateSchemaMigrationStep(params: {
  stateDir: string;
  env: NodeJS.ProcessEnv;
  mode: LegacyStateMigrationMode | "doctor-preparation";
  requiredness: LegacyStateMigrationStep["requiredness"];
}): LegacyStateMigrationStep {
  const stateEnv = { ...params.env, OPENCLAW_STATE_DIR: params.stateDir };
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
      const result = await prepareOpenClawStateDatabaseSchema({ env: stateEnv }, params.mode);
      if (result.changes.length > 0) {
        // Schema repair can expose install records hidden from pre-upgrade discovery.
        clearPluginMetadataLifecycleCaches();
      }
      return result;
    },
  };
}
