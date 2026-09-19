import {
  closeOpenClawStateDatabaseByPathAsync,
  repairOpenClawStateDatabaseSchema,
  repairOpenClawStateDatabaseSchemaIfNeeded,
} from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import type {
  LegacyStateMigrationEndpoint,
  LegacyStateMigrationMode,
  LegacyStateMigrationStep,
} from "./state-migrations.types.js";

export function createStateSchemaMigrationStep(params: {
  stateDir: string;
  env: NodeJS.ProcessEnv;
  mode: LegacyStateMigrationMode;
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
      const result =
        params.mode === "doctor"
          ? repairOpenClawStateDatabaseSchema({ env: stateEnv })
          : repairOpenClawStateDatabaseSchemaIfNeeded({ env: stateEnv });
      // Repair invalidates worker admission; join retirement before the next step acquires custody.
      await closeOpenClawStateDatabaseByPathAsync(database.path);
      return result;
    },
  };
}
