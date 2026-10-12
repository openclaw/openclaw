import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { trackSqliteStatementExecutions } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { runSqliteReadOperationSync } from "../infra/sqlite-schema-facts.js";
import { extractSqliteTableSchema } from "../infra/sqlite-schema-sql.js";
import { runSqliteDeferredTransactionSync } from "../infra/sqlite-transaction.js";
import { prepareOpenClawAgentDatabaseRegistrySnapshotRead } from "./openclaw-agent-db-registry-listing.js";
import {
  registerOpenClawAgentDatabase,
  unregisterOpenClawAgentDatabase,
} from "./openclaw-agent-db-registry.js";
import { readRegisteredAgentDatabaseRows } from "./openclaw-agent-db-registry.read.js";
import { readOpenClawStateReadOnlyLocation } from "./openclaw-state-db-read-connection.js";
import * as stateReads from "./openclaw-state-db-readonly.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "./openclaw-state-db.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "./openclaw-state-schema.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  vi.restoreAllMocks();
  closeOpenClawStateDatabaseForTest();
});

function createRegistry(malformed: boolean) {
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

it("discovers the published registry across overlapping creation and deletion", async () => {
  const options = createRegistry(false);
  const target = (agentId: string) => ({
    agentId,
    env: options.env,
    path: path.join(
      options.env.OPENCLAW_STATE_DIR,
      "agents",
      agentId,
      "agent",
      "openclaw-agent.sqlite",
    ),
  });
  registerOpenClawAgentDatabase(target("main"));
  registerOpenClawAgentDatabase(target("temporary-0"));
  const read = stateReads.executeExistingOpenClawStateRead;
  let publications = 0;
  const reads = vi
    .spyOn(stateReads, "executeExistingOpenClawStateRead")
    .mockImplementation(async (...args) => {
      const reply = await read(...args);
      if (args[1].type === "agentDatabaseRegistry.read" && publications < 3) {
        registerOpenClawAgentDatabase(target(`temporary-${publications + 1}`));
        unregisterOpenClawAgentDatabase(target(`temporary-${publications}`));
        publications++;
      }
      return reply;
    });
  const snapshot = await prepareOpenClawAgentDatabaseRegistrySnapshotRead(options).read();
  expect(snapshot.result).toMatchObject({
    status: "available",
    entries: [{ agentId: "main" }, { agentId: "temporary-3" }],
  });
  expect(snapshot.assertCurrent).not.toThrow();
  expect(reads).toHaveBeenCalledTimes(4);
});

it("reuses migration admission across registry writes and refuses a changed legacy schema", () => {
  const options = createRegistry(false);
  const { db } = openOpenClawStateDatabase(options);
  const read = (artifactPreserving = false) =>
    runSqliteReadOperationSync(db, () =>
      readRegisteredAgentDatabaseRows(db, options.path, artifactPreserving),
    );
  const probes = trackSqliteStatementExecutions(
    db,
    ["legacyWatches", "auditSchema", "registryCatalog"],
    (sql) =>
      sql.includes('from "session_watch_cursors"')
        ? "legacyWatches"
        : /select "type" from "sqlite_master"/iu.test(sql)
          ? "registryCatalog"
          : /\bPRAGMA\s+(?:table_info|index_list|index_info)\([^)]*audit_/iu.test(sql)
            ? "auditSchema"
            : null,
  );
  try {
    expect(read()).toEqual([]);
    expect(probes.counts.legacyWatches).toBe(1);
    expect(probes.counts.auditSchema).toBe(0);
    expect(probes.counts.registryCatalog).toBe(0);
    db.exec(`INSERT INTO agent_databases (agent_id, path, schema_version, last_seen_at, size_bytes)
      VALUES ('worker', 'agents/worker/openclaw-agent.sqlite', 1, 10, NULL)`);
    expect(read()).toEqual([
      {
        agentId: "worker",
        path: path.join(options.env.OPENCLAW_STATE_DIR, "agents/worker/openclaw-agent.sqlite"),
        schemaVersion: 1,
        lastSeenAt: 10,
        sizeBytes: null,
      },
    ]);
    expect(probes.counts.legacyWatches).toBe(1);
    expect(probes.counts.registryCatalog).toBe(0);

    db.exec("ALTER TABLE session_watch_cursors DROP COLUMN provenance");
    expect(() => read()).toThrow("legacy agent database registry schema");
    expect(read(true)).toHaveLength(1);
    db.exec(`DROP TABLE agent_databases;
      CREATE TABLE agent_databases (agent_id TEXT PRIMARY KEY, path TEXT, schema_version INTEGER,
        last_seen_at INTEGER, size_bytes INTEGER)`);
    expect(() => read(true)).toThrow("unsupported agent database registry schema");
  } finally {
    probes.restore();
  }
});

it.each(["native", "replacement"] as const)(
  "refuses audit contract drift after %s schema changes and accepts repaired facts",
  (source) => {
    const options = createRegistry(false);
    let db = openNodeSqliteDatabase(options.path);
    const changeSchema = (sql: string) => {
      if (source === "native") {
        db.exec(sql);
        return;
      }
      db.close();
      const replacementPath = `${options.path}.replacement`;
      fs.copyFileSync(options.path, replacementPath);
      const replacement = new DatabaseSync(replacementPath);
      try {
        replacement.exec(sql);
      } finally {
        replacement.close();
      }
      fs.renameSync(replacementPath, options.path);
      db = openNodeSqliteDatabase(options.path);
    };
    const read = () =>
      runSqliteReadOperationSync(db, () =>
        readRegisteredAgentDatabaseRows(db, options.path, false),
      );
    try {
      expect(read()).toEqual([]);
      for (const [table, constraint, replacement] of [
        ["audit_events", "source_id TEXT NOT NULL UNIQUE", "source_id TEXT NOT NULL"],
        ["audit_identity_keys", "CHECK (id = 1)", "CHECK (id >= 1)"],
      ] as const) {
        const canonical = extractSqliteTableSchema(OPENCLAW_STATE_SCHEMA_SQL, table);
        const malformed = canonical.replace(constraint, replacement);
        expect(malformed).not.toBe(canonical);
        changeSchema(`DROP TABLE ${table}; ${malformed}`);
        expect(() => read()).toThrow("legacy agent database registry schema");
        changeSchema(`DROP TABLE ${table}; ${canonical}`);
        expect(read()).toEqual([]);
      }
    } finally {
      db.close();
    }
  },
);

it("returns registry unavailability only after the fixed native read and worker settle", async () => {
  const options = createRegistry(true);
  const snapshot = await prepareOpenClawAgentDatabaseRegistrySnapshotRead(options).read();
  expect(snapshot.result).toEqual({ status: "unavailable" });
  expect(snapshot.assertCurrent).not.toThrow();
});

it.each([false, true])(
  "retains the failed native reader when malformed registry is %s",
  (malformed) => {
    const options = createRegistry(malformed);
    const failure = new Error("synthetic native reader close failed");
    let retained: DatabaseSync | undefined;
    let restoreClose: (() => void) | undefined;
    let caught: unknown;
    try {
      readOpenClawStateReadOnlyLocation(
        ({ db }) => {
          retained = db;
          const closeSpy = vi.spyOn(db, "close").mockImplementation(() => {
            throw failure;
          });
          restoreClose = () => closeSpy.mockRestore();
          return readRegisteredAgentDatabaseRows(db, options.path, false);
        },
        options.path,
        options.path,
      );
    } catch (error) {
      caught = error;
    }
    expect(retained?.isOpen).toBe(true);
    if (malformed) {
      expect(caught).toBeInstanceOf(AggregateError);
      expect(caught).toMatchObject({ errors: [expect.any(Error), failure] });
    } else {
      expect(caught).toBe(failure);
    }
    restoreClose?.();
    closeOpenClawStateDatabaseForTest();
    expect(retained?.isOpen).toBe(false);
  },
);

it("never certifies a query failure after the transaction owner could not roll it back", () => {
  const options = createRegistry(false);
  const queryFailure = new Error("query failed");
  // The transaction owner records this terminal failure even if native close later succeeds.
  const result = () =>
    readOpenClawStateReadOnlyLocation(
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
