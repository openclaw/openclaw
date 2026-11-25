import assert from "node:assert/strict";
import { threadId } from "node:worker_threads";
import pg from "pg";
import {
  withEngineStoreAdmission,
  installDatabaseProcessRole,
} from "../infra/database-engine/admission-scope.js";
import { installDatabaseEngineSelection } from "../infra/database-engine/context.js";
import { getPostgresPhysicalFacts } from "../infra/database-engine/physical-facts.js";
import { resolveDatabaseFamilyEngines } from "../infra/database-engine/registry.js";
import { withPluginLifecycleLease } from "../plugins/plugin-lifecycle-lease.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "./openclaw-state-db.js";

const engine = process.argv[2];
assert(engine === "postgres" || engine === "sqlite");
assert.equal(threadId, 0);
const connection = process.env.OPENCLAW_TEST_LEASE_PG_CONNECTION;
assert(connection);
installDatabaseProcessRole("gateway");
installDatabaseEngineSelection({
  effectiveEngines: resolveDatabaseFamilyEngines({ database: { engine } }),
  ...(engine === "postgres" ? { postgres: { connection, schemaPrefix: "native_lease" } } : {}),
});
let namespace: string | undefined;
try {
  const database = withEngineStoreAdmission(() => openOpenClawStateDatabase());
  namespace = getPostgresPhysicalFacts(database.db)?.namespace;
  const assertSqlBoundary = () => {
    const query = () => database.db.prepare("SELECT 1").get();
    if (engine === "postgres") {
      assert.throws(query, /PostgreSQL connections must run in a worker/);
    } else {
      assert.doesNotThrow(query);
    }
  };
  assertSqlBoundary();
  await withPluginLifecycleLease({ processBound: true, waitMs: 0 }, async (lease) => {
    lease.assertOwned();
    assertSqlBoundary();
    assert(lease.renew);
    lease.renew();
    lease.assertOwned();
    assertSqlBoundary();
    await withPluginLifecycleLease({ waitMs: 0 }, async (nested) => nested.assertOwned());
  });
  assertSqlBoundary();
  for (const refusal of ["expired", "replaced"]) {
    await assert.rejects(
      withPluginLifecycleLease({ processBound: true, waitMs: 0 }, async (lease) => {
        withEngineStoreAdmission(() =>
          runOpenClawStateWriteTransaction(({ db }) => {
            const sql =
              refusal === "expired"
                ? "UPDATE state_leases SET expires_at = 0 WHERE scope = ? AND lease_key = ?"
                : "UPDATE state_leases SET owner = 'replacement-owner' WHERE scope = ? AND lease_key = ?";
            db.prepare(sql).run("core:plugin-lifecycle", "global");
          }),
        );
        lease.assertOwned();
      }),
      { code: "OPENCLAW_STATE_LEASE_LOST" },
    );
  }
  console.log(`native lease verification, renewal and refusal passed: ${engine}`);
} finally {
  await closeOpenClawStateDatabaseAsync();
  if (namespace) {
    const client = new pg.Client({ connectionString: connection });
    await client.connect();
    try {
      await client.query(`DROP SCHEMA "${namespace.replaceAll('"', '""')}" CASCADE`);
    } finally {
      await client.end();
    }
  }
}
