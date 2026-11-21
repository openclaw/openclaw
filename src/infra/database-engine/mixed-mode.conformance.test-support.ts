import assert from "node:assert/strict";
import { channel } from "node:diagnostics_channel";
import path from "node:path";
import { parentPort, threadId, workerData } from "node:worker_threads";
import { closeOpenClawAgentDatabases } from "../../state/openclaw-agent-db-lifecycle.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabase,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../../state/openclaw-state-db.js";
import { openNodeSqliteDatabase } from "../node-sqlite.js";
import { isPostgresSqlConnection } from "../sql-connection.js";
import {
  installSqliteDatabaseAdmissions,
  type SqliteDatabaseAdmissions,
} from "../sqlite-database-admission.js";
import { installDatabaseEngineSelection } from "./context.js";
import { getPostgresPhysicalFacts } from "./physical-facts.js";
import { withPostgresConnection } from "./postgres-store-metadata.js";
import type { DatabaseEngineSelection } from "./types.js";

export type MixedModeWorkerInput = {
  stateDir: string;
  selection: DatabaseEngineSelection;
  admissions: SqliteDatabaseAdmissions;
};
export type MixedModeWorkerResult = Awaited<ReturnType<typeof inspectOwners>>;

async function inspectOwners(input: MixedModeWorkerInput) {
  assert.notEqual(threadId, 0);
  installDatabaseEngineSelection(input.selection);
  installSqliteDatabaseAdmissions(input.admissions);
  const statementEngines = new Set<string>();
  const statementThreadIds = new Set<number>();
  let statementCount = 0;
  const observer = (message: unknown) => {
    const event = message as { engine: string; threadId: number };
    statementEngines.add(event.engine);
    statementThreadIds.add(event.threadId);
    statementCount++;
  };
  channel("openclaw.database.statement").subscribe(observer);
  const namespaces = new Set<string>();
  const options = { env: { ...process.env, OPENCLAW_STATE_DIR: input.stateDir } };
  try {
    let state = openOpenClawStateDatabase(options);
    const stateEngine = isPostgresSqlConnection(state.db) ? "postgres" : "sqlite";
    if (isPostgresSqlConnection(state.db)) {
      namespaces.add(getPostgresPhysicalFacts(state.db)!.namespace);
    }
    runOpenClawStateWriteTransaction(({ db }) => {
      db.prepare(
        "INSERT INTO config_machine_state (state_key, value_json, updated_at_ms) VALUES (?, ?, ?) ON CONFLICT (state_key) DO UPDATE SET value_json = excluded.value_json",
      ).run("mixed-proof", "retained", 1);
    }, options);
    const agent = openOpenClawAgentDatabase({ ...options, agentId: "mixed-proof" });
    const agentEngine = isPostgresSqlConnection(agent.db) ? "postgres" : "sqlite";
    assert.equal(
      agent.db.prepare("SELECT agent_id FROM schema_meta WHERE meta_key = 'primary'").get()
        ?.agent_id,
      "mixed-proof",
    );
    closeOpenClawAgentDatabases();
    closeOpenClawStateDatabase();
    state = openOpenClawStateDatabase(options);
    const stateValue = state.db
      .prepare("SELECT value_json FROM config_machine_state WHERE state_key = ?")
      .get("mixed-proof")?.value_json;
    const anchor = openNodeSqliteDatabase(
      path.join(input.stateDir, "plugins", "workboard", "workboard.sqlite"),
      { readOnly: true },
    );
    let workboardEngine = "sqlite";
    try {
      if (
        anchor.prepare("SELECT 1 FROM sqlite_schema WHERE name = 'openclaw_engine_anchor'").get()
      ) {
        const namespace = anchor.prepare("SELECT schema FROM openclaw_engine_anchor").get()?.schema;
        assert.equal(typeof namespace, "string");
        assert.match(String(namespace), /^mixed_proof_workboard_[0-9a-f]{16}$/);
        namespaces.add(String(namespace));
        workboardEngine = "postgres";
      }
    } finally {
      anchor.close();
    }
    return {
      stateEngine,
      agentEngine,
      workboardEngine,
      stateValue,
      statementEngines: [...statementEngines].toSorted(),
      statementThreadIds: [...statementThreadIds],
      statementCount,
    };
  } finally {
    closeOpenClawAgentDatabases();
    closeOpenClawStateDatabase();
    channel("openclaw.database.statement").unsubscribe(observer);
    if (input.selection.postgres && namespaces.size) {
      await withPostgresConnection(input.selection.postgres, async (client) => {
        for (const namespace of namespaces) {
          await client.query(`DROP SCHEMA IF EXISTS "${namespace.replaceAll('"', '""')}" CASCADE`);
        }
      });
    }
  }
}

if (parentPort) {
  const port = parentPort;
  try {
    port.postMessage(await inspectOwners(workerData));
  } catch (error) {
    port.postMessage({ error: error instanceof Error ? error.stack : String(error) });
  } finally {
    port.close();
  }
}
