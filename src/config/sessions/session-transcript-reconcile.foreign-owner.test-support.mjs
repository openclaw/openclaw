const params = JSON.parse(process.argv[2]);
const { register } = await import(params.sourceLoaderUrl);
register();
const { acquireGatewayStateOwner } = await import("../../infra/gateway-state-owner.ts");
const { createOpenClawDatabaseMaintenanceScope } =
  await import("../../state/openclaw-state-db-async-lifecycle.ts");
const owner = acquireGatewayStateOwner({ databasePath: params.statePath });
const maintenance = createOpenClawDatabaseMaintenanceScope({
  assertOwnerCurrent: owner.assertCurrent,
  assertDatabaseAccess: owner.assertDatabaseAccess,
});
let result;
try {
  if (params.operation === "exclude") {
    const { assertNoOpenClawAgentDatabaseLeases, OpenClawAgentDatabaseLeaseActiveError } =
      await import("../../state/openclaw-agent-db-lease.ts");
    const { closeOpenClawStateDatabase } = await import("../../state/openclaw-state-db.ts");
    let agentCleanupRefused = false;
    try {
      maintenance.run(() =>
        assertNoOpenClawAgentDatabaseLeases("main", { env: params.environment }),
      );
    } catch (error) {
      if (!(error instanceof OpenClawAgentDatabaseLeaseActiveError)) {
        throw error;
      }
      agentCleanupRefused = true;
    } finally {
      maintenance.run(() => closeOpenClawStateDatabase());
    }
    result = { agentCleanupRefused };
  } else {
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
    result = {
      changed: true,
      ...(params.operation === "version" ? { unchangedSchemaCookie } : {}),
    };
  }
} finally {
  try {
    await maintenance.close();
  } finally {
    owner.release();
  }
}
process.stdout.write(JSON.stringify(result));
