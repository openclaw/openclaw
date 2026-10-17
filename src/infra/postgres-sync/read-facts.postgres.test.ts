import path from "node:path";
import { getEnvironmentData } from "node:worker_threads";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  buildAcpDatabaseSessionKey,
  getAcpSessionKysely,
  readPublishedAcpSessionRows,
} from "../../acp/runtime/session-meta-keys.js";
import type { AcpSessionReadCommand } from "../../acp/runtime/session-meta-read.types.js";
import { readAcpSessionCommand } from "../../acp/runtime/session-meta-read.worker.js";
import {
  applyAcpSessionMutation,
  bindAcpSessionMeta,
} from "../../acp/runtime/session-meta-write.kernel.js";
import { getExactSessionEntryQueries } from "../../config/sessions/session-accessor.sqlite-entry-query.js";
import type { SessionAcpMeta } from "../../config/sessions/types.js";
import { agentEngineSchema } from "../../state/openclaw-agent-db-engine.js";
import { stateEngineSchema } from "../../state/openclaw-state-db-engine.js";
import { withEngineStoreAdmission } from "../database-engine/admission-scope.js";
import type { StoreSchema } from "../database-engine/contract.js";
import { openEngineStore, readEngineAnchor } from "../database-engine/open.js";
import { getPostgresPhysicalFacts } from "../database-engine/physical-facts.js";
import { executeSqliteQuerySync } from "../kysely-sync.js";
import { openNodeSqliteDatabase } from "../node-sqlite.js";
import { isPostgresSqlConnection, type PostgresSqlConnection } from "../sql-connection.js";
import { readSqliteDatabaseWriteRevision } from "../sqlite-database-admission.js";
import { admitSqliteSchema } from "../sqlite-schema-facts.js";
import { runSqliteReadSnapshotSync } from "../sqlite-transaction.js";

const configured: unknown = getEnvironmentData("openclaw.test.workboard.connection");
const connection = typeof configured === "string" ? configured : undefined;
type StoreFixture = {
  pathname: string;
  writer: PostgresSqlConnection;
  open: () => PostgresSqlConnection;
  close: () => void;
};
const stores: StoreFixture[] = [];
const directories = useAutoCleanupTempDirTracker((cleanup) =>
  afterAll(() => {
    try {
      withEngineStoreAdmission(() => {
        for (const store of stores.splice(0)) {
          store.close();
        }
      });
    } finally {
      cleanup();
    }
  }),
);

function openStore(schema: StoreSchema): StoreFixture {
  const pathname = path.join(directories.make("pg-read-facts-"), "anchor.sqlite");
  const handles: {
    db: PostgresSqlConnection;
    anchor: ReturnType<typeof openNodeSqliteDatabase>;
  }[] = [];
  const open = () => {
    const anchor = openNodeSqliteDatabase(pathname);
    try {
      const db = openEngineStore({
        anchor,
        schema,
        input: { connection: connection!, schemaPrefix: "read_facts" },
        openSqlite: () => {
          throw new Error("Expected PostgreSQL store");
        },
        prepareAnchor: () => {},
        inspectSqlite: () => {
          admitSqliteSchema(anchor);
          return { hasExistingData: false, hasEngineAnchor: Boolean(readEngineAnchor(anchor)) };
        },
      });
      if (!isPostgresSqlConnection(db)) {
        throw new Error("Expected PostgreSQL connection");
      }
      handles.push({ db, anchor });
      return db;
    } catch (error) {
      anchor.close();
      throw error;
    }
  };
  const writer = open();
  const facts = getPostgresPhysicalFacts(writer);
  if (!facts) {
    throw new Error("Expected production schema admission");
  }
  const store = {
    pathname,
    writer,
    open,
    close() {
      try {
        writer.exec(`DROP SCHEMA "${facts.namespace}" CASCADE`);
      } finally {
        for (const { db, anchor } of handles) {
          db.close();
          anchor.close();
        }
      }
    },
  };
  stores.push(store);
  return store;
}

function metadata(runtimeSessionName: string): SessionAcpMeta {
  return {
    backend: "fixture",
    agent: "main",
    runtimeSessionName,
    mode: "persistent",
    state: "idle",
    lastActivityAt: 100,
  };
}

function commandFor(...names: string[]) {
  return {
    type: "acpSessions.metadata",
    entries: names.map((name) => ({
      keys: [buildAcpDatabaseSessionKey(`agent:main:acp:${name}`, "main")],
      entry: { sessionId: "session", lifecycleRevision: "generation" },
    })),
  } satisfies AcpSessionReadCommand;
}

function seedAcp(db: PostgresSqlConnection, name: string, value: string) {
  // Seed durable rows without the writer's optional metadata postimage publication.
  db.runTransaction(() =>
    executeSqliteQuerySync(
      db,
      getAcpSessionKysely(db)
        .insertInto("acp_sessions")
        .values(
          bindAcpSessionMeta({
            sessionKey: buildAcpDatabaseSessionKey(`agent:main:acp:${name}`, "main"),
            lifecycleRevision: "generation",
            updatedAt: 100,
            meta: metadata(value),
          }),
        ),
    ),
  );
}

function writeAcp(db: PostgresSqlConnection, name: string, value: string | null) {
  const sessionKey = `agent:main:acp:${name}`;
  return db.runTransaction(() =>
    applyAcpSessionMutation(db, {
      agentId: "main",
      storageSessionKey: sessionKey,
      sessionKey,
      entry: { sessionId: "session", lifecycleRevision: "generation", updatedAt: 200 },
      decision: value === null ? { kind: "clear" } : { kind: "set", meta: metadata(value) },
    }),
  );
}

describe.skipIf(!connection)("PostgreSQL admitted read facts", () => {
  let state: StoreFixture;
  beforeAll(() => {
    withEngineStoreAdmission(() => {
      state = openStore(stateEngineSchema);
      state.writer.exec("CREATE EXTENSION IF NOT EXISTS unaccent WITH SCHEMA public");
    });
  });

  it("publishes positive and absent ACP rows after snapshot close and consumes typed postimages", () => {
    withEngineStoreAdmission(() => {
      const input = commandFor("published", "absent");
      seedAcp(state.writer, "published", "initial");
      const reader = state.open();
      const query = vi.spyOn(reader, "query");
      const metadataReads = () =>
        query.mock.calls.filter(([sql]) => /\b(?:from|join)\s+"?acp_sessions\b/iu.test(sql));
      try {
        runSqliteReadSnapshotSync(reader, () => {
          expect(readAcpSessionCommand(reader, input).rows).toMatchObject([
            { runtime_session_name: "initial" },
            null,
          ]);
          expect(readPublishedAcpSessionRows(state.pathname, input.entries)).toBeUndefined();
        });
        expect(metadataReads()).toHaveLength(1);
        expect(readPublishedAcpSessionRows(state.pathname, input.entries)).toMatchObject([
          { runtime_session_name: "initial" },
          null,
        ]);
        query.mockClear();
        const revision = readSqliteDatabaseWriteRevision(reader);
        writeAcp(state.writer, "absent", "created");
        expect(readSqliteDatabaseWriteRevision(reader)).not.toBe(revision);
        expect(
          runSqliteReadSnapshotSync(reader, () => readAcpSessionCommand(reader, input)).rows,
        ).toMatchObject([{ runtime_session_name: "initial" }, { runtime_session_name: "created" }]);
        writeAcp(state.writer, "published", null);
        expect(
          runSqliteReadSnapshotSync(reader, () => readAcpSessionCommand(reader, input)).rows,
        ).toMatchObject([null, { runtime_session_name: "created" }]);
        expect(metadataReads()).toHaveLength(0);
      } finally {
        query.mockRestore();
      }
    });
  });

  it("discards read-derived ACP facts when the snapshot callback fails", () => {
    withEngineStoreAdmission(() => {
      const input = commandFor("aborted-positive", "aborted-negative");
      seedAcp(state.writer, "aborted-positive", "durable");
      const reader = state.open();
      expect(() =>
        runSqliteReadSnapshotSync(reader, () => {
          expect(readAcpSessionCommand(reader, input).rows).toMatchObject([
            { runtime_session_name: "durable" },
            null,
          ]);
          throw new Error("abort snapshot");
        }),
      ).toThrow("abort snapshot");
      expect(readPublishedAcpSessionRows(state.pathname, input.entries)).toBeUndefined();
      runSqliteReadSnapshotSync(reader, () => readAcpSessionCommand(reader, input));
      expect(readPublishedAcpSessionRows(state.pathname, input.entries)).toMatchObject([
        { runtime_session_name: "durable" },
        null,
      ]);
    });
  });

  it("does not publish ACP facts when snapshot closure has an unknown outcome", () => {
    withEngineStoreAdmission(() => {
      const input = commandFor("unknown-close");
      const reader = state.open();
      const exec = reader.exec.bind(reader);
      const close = vi.spyOn(reader, "exec").mockImplementation((sql) => {
        exec(sql);
        if (sql === "ROLLBACK") {
          throw new Error("snapshot close response lost");
        }
      });
      try {
        expect(() =>
          runSqliteReadSnapshotSync(reader, () => {
            expect(readAcpSessionCommand(reader, input).rows).toEqual([null]);
          }),
        ).toThrow("snapshot close response lost");
        expect(readPublishedAcpSessionRows(state.pathname, input.entries)).toBeUndefined();
      } finally {
        close.mockRestore();
      }
      runSqliteReadSnapshotSync(reader, () => readAcpSessionCommand(reader, input));
      expect(readPublishedAcpSessionRows(state.pathname, input.entries)).toEqual([null]);
    });
  });

  it("keeps old ACP snapshots isolated from newer positive and negative postimages", () => {
    withEngineStoreAdmission(() => {
      const input = commandFor("overlap-positive", "overlap-negative");
      seedAcp(state.writer, "overlap-positive", "before");
      const reader = state.open();
      runSqliteReadSnapshotSync(reader, () => {
        expect(readAcpSessionCommand(reader, input).rows).toMatchObject([
          { runtime_session_name: "before" },
          null,
        ]);
        writeAcp(state.writer, "overlap-positive", null);
        writeAcp(state.writer, "overlap-negative", "after");
        expect(readPublishedAcpSessionRows(state.pathname, input.entries)).toMatchObject([
          null,
          { runtime_session_name: "after" },
        ]);
        expect(readAcpSessionCommand(reader, input).rows).toMatchObject([
          { runtime_session_name: "before" },
          null,
        ]);
      });
      expect(readPublishedAcpSessionRows(state.pathname, input.entries)).toMatchObject([
        null,
        { runtime_session_name: "after" },
      ]);
      expect(
        runSqliteReadSnapshotSync(reader, () => readAcpSessionCommand(reader, input)).rows,
      ).toMatchObject([null, { runtime_session_name: "after" }]);
    });
  });

  it("reuses exact session rows only in their original snapshot and refreshes the next snapshot", () => {
    withEngineStoreAdmission(() => {
      const agent = openStore(agentEngineSchema);
      const key = "agent:main:read-facts";
      const insert = (sessionKey: string, sessionId: string) =>
        agent.writer.runTransaction(() =>
          agent.writer
            .prepare(
              "INSERT INTO session_nodes (session_key, current_session_id, entry_json, updated_at) VALUES (?, ?, ?, ?)",
            )
            .run(sessionKey, sessionId, JSON.stringify({ sessionId, updatedAt: 100 }), 100),
        );
      insert(key, "before");
      const reader = agent.open();
      const queries = getExactSessionEntryQueries(reader);
      const query = vi.spyOn(reader, "query");
      const rowReads = () =>
        query.mock.calls.filter(([sql]) => /\bfrom\s+"?session_nodes\b/iu.test(sql));
      try {
        runSqliteReadSnapshotSync(reader, () => {
          expect(queries.row(key)?.current_session_id).toBe("before");
          expect(queries.row(key)?.current_session_id).toBe("before");
          agent.writer.runTransaction(() =>
            agent.writer
              .prepare("UPDATE session_nodes SET current_session_id = ? WHERE session_key = ?")
              .run("after", key),
          );
          expect(queries.row(key)?.current_session_id).toBe("before");
          expect(rowReads()).toHaveLength(1);
        });
        query.mockClear();
        runSqliteReadSnapshotSync(reader, () => {
          expect(queries.row(key)?.current_session_id).toBe("after");
          expect(queries.row(key)?.current_session_id).toBe("after");
        });
        expect(rowReads()).toHaveLength(1);
        query.mockClear();
        const absentKey = `${key}:absent`;
        runSqliteReadSnapshotSync(reader, () => {
          expect(queries.row(absentKey)).toBeUndefined();
          expect(queries.row(absentKey)).toBeUndefined();
          insert(absentKey, "created");
          expect(queries.row(absentKey)).toBeUndefined();
          expect(rowReads()).toHaveLength(1);
        });
        query.mockClear();
        runSqliteReadSnapshotSync(reader, () => {
          expect(queries.row(absentKey)?.current_session_id).toBe("created");
          expect(queries.row(absentKey)?.current_session_id).toBe("created");
        });
        expect(rowReads()).toHaveLength(1);
      } finally {
        query.mockRestore();
      }
    });
  });
});
