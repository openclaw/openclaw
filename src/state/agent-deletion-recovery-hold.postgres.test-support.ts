import assert from "node:assert/strict";
import path from "node:path";
import { threadId } from "node:worker_threads";
import pg from "pg";
import { assertCurrentAgentDeletionRecoveryHolds } from "../agents/workspace-file-mutation-guard.js";
import {
  installDatabaseProcessRole,
  withEngineStoreAdmission,
} from "../infra/database-engine/admission-scope.js";
import { installDatabaseEngineSelection } from "../infra/database-engine/context.js";
import { getPostgresPhysicalFacts } from "../infra/database-engine/physical-facts.js";
import { resolveDatabaseFamilyEngines } from "../infra/database-engine/registry.js";
import { recordAgentDeletionRecoveryHolds } from "./agent-deletion-journal-recovery.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "./openclaw-state-db.js";

const engine = process.argv[2];
assert(engine === "postgres" || engine === "sqlite");
assert.equal(threadId, 0);
const connection = process.env.OPENCLAW_TEST_RECOVERY_HOLD_PG_CONNECTION;
const stateDir = process.env.OPENCLAW_STATE_DIR;
assert(connection);
assert(stateDir);
installDatabaseProcessRole("gateway");
installDatabaseEngineSelection({
  effectiveEngines: resolveDatabaseFamilyEngines({ database: { engine } }),
  ...(engine === "postgres" ? { postgres: { connection, schemaPrefix: "recovery_hold" } } : {}),
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
  assertCurrentAgentDeletionRecoveryHolds({ agentId: "helper", held: [], applies: true });
  assertSqlBoundary();
  const held = withEngineStoreAdmission(() =>
    runOpenClawStateWriteTransaction((state) =>
      recordAgentDeletionRecoveryHolds(state, [
        {
          agentId: "helper",
          path: path.join(stateDir, "agents", "helper", "agent", "openclaw-agent.sqlite"),
        },
      ]),
    ),
  );
  assert.throws(
    () => assertCurrentAgentDeletionRecoveryHolds({ agentId: "helper", held: [], applies: true }),
    /Agent helper has held databases/,
  );
  assertCurrentAgentDeletionRecoveryHolds({ agentId: "helper", held, applies: true });
  assertCurrentAgentDeletionRecoveryHolds({ agentId: "other", held: [], applies: true });
  assertSqlBoundary();
  console.log(`agent deletion recovery hold check passed on the Gateway thread: ${engine}`);
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
