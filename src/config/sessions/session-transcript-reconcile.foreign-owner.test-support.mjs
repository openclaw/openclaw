const params = JSON.parse(process.argv[2]);
const { register } = await import(params.sourceLoaderUrl);
register();
const { withStateDatabaseCoordinatorRuntimeDirectory, acquireStateDatabaseCoordinator } =
  await import("../../infra/state-database-coordinator.ts");
const { acquireOpenClawStateDatabaseFileExclusion } =
  await import("../../state/openclaw-state-db-cache.ts");
const result = await withStateDatabaseCoordinatorRuntimeDirectory(
  { ...params.runtime, keepAlive: false },
  async () => {
    if (params.operation === "exclude") {
      const { assertNoOpenClawAgentDatabaseLeases, OpenClawAgentDatabaseLeaseActiveError } =
        await import("../../state/openclaw-agent-db-lease.ts");
      const { closeOpenClawStateDatabase } = await import("../../state/openclaw-state-db.ts");
      let agentCleanupRefused = false;
      try {
        assertNoOpenClawAgentDatabaseLeases("main", {
          env: params.environment,
        });
      } catch (error) {
        if (!(error instanceof OpenClawAgentDatabaseLeaseActiveError)) {
          throw error;
        }
        agentCleanupRefused = true;
      } finally {
        closeOpenClawStateDatabase();
      }
      try {
        const exclusion = await acquireOpenClawStateDatabaseFileExclusion(params.statePath);
        exclusion.release();
        return { acquired: true, agentCleanupRefused };
      } catch (error) {
        return { acquired: false, family: error.family, name: error.name, agentCleanupRefused };
      }
    }
    const lifecycle = acquireStateDatabaseCoordinator({ databasePath: params.statePath });
    try {
      const { DatabaseSync } = await import("node:sqlite");
      const database = new DatabaseSync(params.agentPath);
      let unchangedSchemaCookie;
      try {
        if (params.operation === "version") {
          const cookie = database.prepare("PRAGMA schema_version").get().schema_version;
          database.exec("PRAGMA user_version = 2147483647");
          unchangedSchemaCookie =
            database.prepare("PRAGMA schema_version").get().schema_version === cookie;
        } else {
          // Synthetic out-of-band DDL proves reentry cannot adopt changed schema facts.
          database.exec("CREATE TABLE synthetic_schema_reentry_guard (value INTEGER)");
        }
      } finally {
        database.close();
      }
      return {
        changed: true,
        ...(params.operation === "version" ? { unchangedSchemaCookie } : {}),
      };
    } finally {
      lifecycle.release();
    }
  },
);
process.stdout.write(JSON.stringify(result));
