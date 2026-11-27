import assert from "node:assert/strict";
import path from "node:path";
import { threadId } from "node:worker_threads";
import pg from "pg";
import { loadLegacyCronRepairState } from "../commands/doctor/cron/legacy-repair.js";
import { cronTestJob } from "../cron/service.fixture-builders.test-support.js";
import { cronStoreKey } from "../cron/store/key.js";
import { saveCronStoreInDatabase } from "../cron/store/save.kernel.js";
import {
  installDatabaseProcessRole,
  withEngineStoreAdmission,
} from "../infra/database-engine/admission-scope.js";
import { installDatabaseEngineSelection } from "../infra/database-engine/context.js";
import { getPostgresPhysicalFacts } from "../infra/database-engine/physical-facts.js";
import { resolveDatabaseFamilyEngines } from "../infra/database-engine/registry.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "./openclaw-state-db.js";

const engine = process.argv[2];
assert(engine === "postgres" || engine === "sqlite");
assert.equal(threadId, 0);
const connection = process.env.OPENCLAW_TEST_CRON_OWNER_PG_CONNECTION;
const stateDir = process.env.OPENCLAW_STATE_DIR;
assert(connection);
assert(stateDir);
installDatabaseProcessRole("gateway");
installDatabaseEngineSelection({
  effectiveEngines: resolveDatabaseFamilyEngines({ database: { engine } }),
  ...(engine === "postgres" ? { postgres: { connection, schemaPrefix: "cron_owner" } } : {}),
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
  const storePath = path.join(stateDir, "cron", "jobs.json");
  withEngineStoreAdmission(() =>
    runOpenClawStateWriteTransaction((state) =>
      saveCronStoreInDatabase(state, cronStoreKey(storePath), {
        version: 1,
        jobs: [cronTestJob({ id: "owned-job", agentId: "main" })],
      }),
    ),
  );
  assertSqlBoundary();
  const repair = await loadLegacyCronRepairState({
    cfg: {},
    storePath,
    env: process.env,
    readOnly: true,
  });
  assert.deepEqual(
    repair?.ownerRows.map((row) => [row.job_id, row.agent_id]),
    [["owned-job", "main"]],
  );
  assertSqlBoundary();
  console.log(`cron owner inspection passed on the Gateway thread: ${engine}`);
} finally {
  await closeOpenClawStateDatabaseAsync();
  if (namespace) {
    const client = new pg.Client({ connectionString: connection });
    await client.connect();
    try {
      await client.query(`DROP SCHEMA IF EXISTS ${client.escapeIdentifier(namespace)} CASCADE`);
    } finally {
      await client.end();
    }
  }
}
