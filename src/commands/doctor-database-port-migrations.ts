import path from "node:path";
import { resolveOAuthDir } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.js";
import { discoverBackupDatabasePaths } from "../infra/backup-sqlite-snapshot.js";
import { agentPortProvider } from "../infra/database-engine/agent-port.js";
import { DatabasePortError } from "../infra/database-engine/port-command.worker.js";
import { databasePortProviders } from "../infra/database-engine/port-provider.js";
import {
  listDatabaseEngineStores,
  selectDatabaseEngine,
  type DatabaseEngineId,
} from "../infra/database-engine/registry.js";
import { statePortProvider } from "../infra/database-engine/state-port.js";
import { admitSqliteSchema, getAdmittedSqliteSchemaFacts } from "../infra/sqlite-schema-facts.js";
import { openSqliteReadOnlyDatabase } from "../infra/sqlite-snapshot-source.js";
import { createPluginDoctorStateMigrationInput } from "../infra/state-migrations.plugin-doctor.js";
import { listPluginDoctorStateMigrationEntries } from "../plugins/doctor-contract-registry.js";
import { resolvePluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import { readBackupEngine } from "../snapshot/database-backup.js";
import { withArtifactPreservingStateReads } from "../state/artifact-preserving-state-reads.js";
import {
  privatePaths,
  type Context,
  type DatabasePortFamily,
} from "./doctor-database-port-context.js";
import { readReservedIncognitoKeyRepairState } from "./doctor-session-incognito-key-repair-state.js";
import { listReservedIncognitoKeys } from "./doctor-session-incognito-key-repair.js";

class DatabasePortReservedIncognitoKeysError extends DatabasePortError {
  readonly code = "RESERVED_INCOGNITO_SESSION_KEYS";

  constructor() {
    super(
      "Database port found unrepaired reserved-incognito session keys. Run openclaw doctor --fix on the SQLite installation, then retry adoption.",
    );
  }
}

/** The global rename must finish on SQLite before any selected agent leaves that repair owner. */
function assertDatabasePortReservedIncognitoKeysRepaired(params: {
  paths: readonly string[];
  includeAgents: boolean;
}): void {
  for (const pathname of params.paths) {
    if (readBackupEngine(pathname).engine !== "sqlite") {
      continue;
    }
    using db = openSqliteReadOnlyDatabase(pathname);
    admitSqliteSchema(db);
    const tables = getAdmittedSqliteSchemaFacts(db)!.tables;
    let pending = false;
    if (statePortProvider.matchesSqlite(tables)) {
      const state = readReservedIncognitoKeyRepairState(db);
      pending = state.reservedKeys.length > 0 || state.renames.length > 0;
    } else if (params.includeAgents && agentPortProvider.matchesSqlite(tables)) {
      pending = listReservedIncognitoKeys(db).length > 0;
    }
    if (pending) {
      throw new DatabasePortReservedIncognitoKeysError();
    }
  }
}

/** Metadata discovery can open shared state too; preserve sources before the repair gate. */
export function inspectDatabasePortSources(
  ctx: Context,
  config: OpenClawConfig,
  from: DatabaseEngineId,
  to: DatabaseEngineId,
) {
  return withArtifactPreservingStateReads(
    async () => {
      const context = { stateDir: ctx.stateDir, config, env: ctx.env };
      const plugins = resolvePluginMetadataSnapshot(context);
      const families = await Promise.all(
        databasePortProviders.map(async (provider) => ({
          id: provider.id,
          roots: await provider.resolveRoots({ ...context, plugins }),
        })),
      );
      const roots = families.flatMap((family) => family.roots);
      privatePaths(ctx, roots);
      const all = await discoverBackupDatabasePaths(context);
      const owner = (file: string) =>
        families.find((family) =>
          family.roots.some((root) => file === root || file.startsWith(`${root}${path.sep}`)),
        )?.id;
      if (
        from === "sqlite" &&
        to === "postgres" &&
        (!ctx.family || ctx.family === "state" || ctx.family === "agent")
      ) {
        assertDatabasePortReservedIncognitoKeysRepaired({
          paths: all,
          includeAgents: !ctx.family || ctx.family === "agent",
        });
      }
      return { all, owner };
    },
    { agentDatabases: true },
  );
}

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
