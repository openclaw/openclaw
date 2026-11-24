import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { postgresStoreNamespace } from "../infra/database-engine/postgres-schema.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { usePostgresTestHarness } from "../infra/postgres-sync/postgres.test-support.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { STATE_SUPERVISION_KEY } from "../state/openclaw-state-ownership.js";
import { runStateOwnerCli, stateOwnerEnv } from "./cli-process-fixture.test-support.js";

const fixture = usePostgresTestHarness("ownstat");

it.skipIf(!fixture.connection)("reports the persisted PostgreSQL ownership claim", async () => {
  const env = stateOwnerEnv(fixture.directories.make("oc-postgres-owner-"));
  fs.writeFileSync(
    env.OPENCLAW_CONFIG_PATH!,
    JSON.stringify({
      env: { vars: { OPENCLAW_STATE_DIR: env.OPENCLAW_STATE_DIR } },
      database: {
        engine: "postgres",
        postgres: { connection: fixture.connection, schemaPrefix: fixture.prefix },
      },
    }),
  );

  const databasePath = resolveOpenClawStateSqlitePath(env);
  const storeId = randomUUID();
  const namespace = postgresStoreNamespace(fixture.prefix, "state", storeId);
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  {
    using anchor = openNodeSqliteDatabase(databasePath);
    anchor.exec("CREATE TABLE openclaw_engine_anchor (store_id TEXT, engine TEXT, schema TEXT)");
    anchor
      .prepare("INSERT INTO openclaw_engine_anchor VALUES (?, 'postgres', ?)")
      .run(storeId, namespace);
  }
  const prepared = await runStateOwnerCli(env, [
    "database",
    "prepare-state",
    "--expected-store-id",
    storeId,
    "--expected-namespace",
    namespace,
    "--json",
  ]);
  expect(prepared.code, prepared.stdout + prepared.stderr).toBe(0);

  const ownership = { version: 1, mode: "external", managerId: "supervisor", claimedAt: 1 };
  await fixture.client.query(
    `INSERT INTO "${namespace}".config_machine_state (state_key, value_json, updated_at_ms)
     VALUES ($1, $2, $3)`,
    [STATE_SUPERVISION_KEY, JSON.stringify(ownership), ownership.claimedAt],
  );

  const anchor = fs.readFileSync(databasePath);
  for (const statusEnv of [env, { ...env, OPENCLAW_STATE_DIR: undefined }]) {
    const result = await runStateOwnerCli(statusEnv, ["database", "ownership", "status", "--json"]);
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ databasePath, status: "external", ownership });
  }
  expect(fs.readFileSync(databasePath)).toEqual(anchor);
});
