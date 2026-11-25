import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { runSqliteReadOperationSync as runRead } from "../infra/sqlite-schema-facts.js";
import { runSqliteDeferredTransactionSync } from "../infra/sqlite-transaction.js";
import {
  listOpenClawRegisteredAgentDatabasesAsync as listAgentDbs,
  prepareOpenClawAgentDatabaseRegistrySnapshotRead as prepareRegistryRead,
} from "./openclaw-agent-db-registry-listing.js";
import {
  registerOpenClawAgentDatabase as registerAgentDb,
  unregisterOpenClawAgentDatabase as unregisterAgentDb,
} from "./openclaw-agent-db-registry.js";
import { readRegisteredAgentDatabaseRows as readRegistryRows } from "./openclaw-agent-db-registry.read.js";
import { readOpenClawStateReadOnlyLocation as readStateLocation } from "./openclaw-state-db-read-connection.js";
import * as stateReads from "./openclaw-state-db-readonly.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "./openclaw-state-db.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  vi.restoreAllMocks();
  closeOpenClawStateDatabaseForTest();
});

function createRegistry(malformed = false) {
  const stateDir = tempDirs.make("openclaw-registry-settled-");
  const options = {
    path: path.join(stateDir, "state", "openclaw.sqlite"),
    env: { OPENCLAW_STATE_DIR: stateDir, OPENCLAW_TEST_FAST: "1" },
  };
  const database = openOpenClawStateDatabase(options);
  if (malformed) {
    database.db.exec("DROP TABLE agent_databases; CREATE VIEW agent_databases AS SELECT 1");
  }
  closeOpenClawStateDatabaseForTest();
  return options;
}

function registration(options: ReturnType<typeof createRegistry>, agentId: string) {
  return {
    agentId,
    env: options.env,
    path: path.join(
      options.env.OPENCLAW_STATE_DIR,
      "agents",
      agentId,
      "agent/openclaw-agent.sqlite",
    ),
  };
}

it("observes committed registration and removal", async () => {
  const options = createRegistry();
  const target = registration(options, "worker");
  const check = async (expected: unknown[]) => {
    expect(await listAgentDbs(options)).toMatchObject(expected);
  };
  await check([]);
  registerAgentDb(target);
  await check([{ agentId: target.agentId, path: target.path }]);
  unregisterAgentDb(target);
  await check([]);
});

it("discovers the published registry across overlapping creation and deletion", async () => {
  const options = createRegistry();
  const target = (agentId: string) => registration(options, agentId);
  registerAgentDb(target("main"));
  registerAgentDb(target("temporary-0"));
  const read = stateReads.executeExistingOpenClawStateRead;
  let publications = 0;
  vi.spyOn(stateReads, "executeExistingOpenClawStateRead").mockImplementation(async (...args) => {
    const reply = await read(...args);
    if (args[1].type === "agentDatabaseRegistry.read" && publications < 3) {
      registerAgentDb(target(`temporary-${publications + 1}`));
      unregisterAgentDb(target(`temporary-${publications}`));
      publications++;
    }
    return reply;
  });
  const snapshot = await prepareRegistryRead(options).read();
  expect(snapshot.result).toMatchObject({
    status: "available",
    entries: [{ agentId: "main" }, { agentId: "temporary-3" }],
  });
  expect(snapshot.assertCurrent).not.toThrow();
});

it("reuses registry admission across writes and unrelated pending migrations", () => {
  const options = createRegistry();
  const { db } = openOpenClawStateDatabase(options);
  const read = (artifactPreserving = false) =>
    runRead(db, () => readRegistryRows(db, options.path, artifactPreserving));
  const checkBoth = (expected: unknown[]) => {
    expect(read(true)).toEqual(expected);
    expect(read()).toEqual(expected);
  };
  checkBoth([]);
  db.exec(`INSERT INTO agent_databases (agent_id, path, schema_version, last_seen_at, size_bytes)
      VALUES ('worker', 'agents/worker/openclaw-agent.sqlite', 1, 10, NULL)`);
  const expectedRows = [
    {
      agentId: "worker",
      path: path.join(options.env.OPENCLAW_STATE_DIR, "agents/worker/openclaw-agent.sqlite"),
      schemaVersion: 1,
      lastSeenAt: 10,
      sizeBytes: null,
    },
  ];
  checkBoth(expectedRows);

  db.exec("ALTER TABLE session_watch_cursors DROP COLUMN provenance");
  expect(read(true)).toEqual(expectedRows);
  expect(read()).toEqual(expectedRows);
  db.exec(`DROP TABLE agent_databases;
      CREATE TABLE agent_databases (agent_id TEXT PRIMARY KEY, path TEXT, schema_version INTEGER,
        last_seen_at INTEGER, size_bytes INTEGER)`);
  expect(() => read(true)).toThrow("unsupported agent database registry schema");
  expect(() => read()).toThrow("unsupported agent database registry schema");
});

it("refuses a pending migration that changes agent database registry paths", () => {
  const options = createRegistry();
  const { db } = openOpenClawStateDatabase(options);
  db.exec(`PRAGMA user_version = 8;
    UPDATE schema_meta SET schema_version = 8;
    DELETE FROM config_machine_state WHERE state_key = 'state.schema.contentVersion';`);
  expect(() => runRead(db, () => readRegistryRows(db, options.path, false))).toThrow(
    "legacy agent database registry schema",
  );
});

it("returns registry unavailability only after the fixed native read and worker settle", async () => {
  const options = createRegistry(true);
  const snapshot = await prepareRegistryRead(options).read();
  expect(snapshot.result).toEqual({ status: "unavailable" });
  expect(snapshot.assertCurrent).not.toThrow();
});

it("never certifies a query failure after the transaction owner could not roll it back", () => {
  const options = createRegistry();
  const queryFailure = new Error("query failed");
  // The transaction owner records this terminal failure even if native close later succeeds.
  const result = () =>
    readStateLocation(
      ({ db }) => {
        const exec = db.exec.bind(db);
        vi.spyOn(db, "exec").mockImplementation((sql) => {
          if (sql === "ROLLBACK") {
            throw new Error("rollback failed");
          }
          return exec(sql);
        });
        return runSqliteDeferredTransactionSync(db, () => {
          throw queryFailure;
        });
      },
      options.path,
      options.path,
    );
  expect(result).toThrow(queryFailure);
});
