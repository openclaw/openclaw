import { resolveOAuthDir } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.js";
import { DatabasePortError } from "../infra/database-engine/port-command.worker.js";
import {
  listDatabaseEngineStores,
  selectDatabaseEngine,
  type DatabaseEngineId,
} from "../infra/database-engine/registry.js";
import { createPluginDoctorStateMigrationInput } from "../infra/state-migrations.plugin-doctor.js";
import { listPluginDoctorStateMigrationEntries } from "../plugins/doctor-contract-registry.js";
import { withArtifactPreservingStateReads } from "../state/artifact-preserving-state-reads.js";
import type { DatabasePortFamily } from "./doctor-database-port-context.js";

/** Legacy imports must finish while their destination family still accepts SQLite writes. */
export async function assertDatabasePortPluginMigrationsComplete(params: {
  config: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  stateDir: string;
  to: DatabaseEngineId;
  family?: DatabasePortFamily;
}): Promise<void> {
  const target = {
    ...params.config,
    database: { ...params.config.database, engine: params.to },
  };
  const families = new Set(
    listDatabaseEngineStores()
      .filter(
        (store) =>
          store.postgres &&
          selectDatabaseEngine(store, params.config) === "sqlite" &&
          (params.family
            ? store.id === params.family && params.to === "postgres"
            : selectDatabaseEngine(store, target) === "postgres"),
      )
      .map((store) => store.id),
  );
  if (families.size === 0) {
    return;
  }
  await withArtifactPreservingStateReads(
    async () => {
      let entries: ReturnType<typeof listPluginDoctorStateMigrationEntries>;
      try {
        entries = listPluginDoctorStateMigrationEntries({ ...params, includeDisabled: true });
      } catch {
        throw new DatabasePortError(
          "Database port could not inspect registered plugin migrations. Run openclaw doctor --fix first, then retry port.",
        );
      }
      const pending: string[] = [];
      for (const entry of entries) {
        const source = entry.migration.sqliteOnly;
        if (!source || !families.has(source.family)) {
          continue;
        }
        const name = `${entry.pluginId}/${entry.migration.id} (${entry.migration.label})`;
        try {
          const detected = await entry.migration.detectLegacyState(
            createPluginDoctorStateMigrationInput(
              { ...params, oauthDir: resolveOAuthDir(params.env, params.stateDir) },
              entry,
            ),
          );
          if (detected !== null) {
            pending.push(name);
          }
        } catch {
          throw new DatabasePortError(
            `Database port could not inspect SQLite migration ${name}. Run openclaw doctor --fix first, then retry port.`,
          );
        }
      }
      if (pending.length > 0) {
        throw new DatabasePortError(
          `Database port requires pending SQLite migrations: ${pending.join(", ")}. Run openclaw doctor --fix first, then retry port. If a named plugin is disabled, enable it for repair.`,
        );
      }
    },
    { agentDatabases: true },
  );
}
