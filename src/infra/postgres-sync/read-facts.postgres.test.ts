import assert from "node:assert/strict";
import path from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
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
import { usePostgresTestHarness } from "./postgres.test-support.js";
import { failAfterStatement } from "./sql.test-support.js";

const harness = usePostgresTestHarness("read_facts");
const { connection, prefix, directories } = harness;
type StoreFixture = ReturnType<typeof openStore>;

function openStore(schema: StoreSchema) {
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
        input: { connection: connection!, schemaPrefix: prefix },
        openSqlite: () => {
          throw new Error("Expected PostgreSQL store");
        },
        prepareAnchor: () => {},
        inspectSqlite: () => {
          admitSqliteSchema(anchor);
          return { hasExistingData: false, hasEngineAnchor: Boolean(readEngineAnchor(anchor)) };
        },
      });
      assert(isPostgresSqlConnection(db), "Expected PostgreSQL connection");
      handles.push({ db, anchor });
      return db;
    } catch (error) {
      anchor.close();
      throw error;
    }
  };
  const writer = open();
  assert(getPostgresPhysicalFacts(writer), "Expected production schema admission");
  harness.onClose(() =>
    withEngineStoreAdmission(() => {
      for (const { db, anchor } of handles) {
        db.close();
        anchor.close();
      }
    }),
  );
  return { pathname, writer, open };
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
  const row = bindAcpSessionMeta({
    sessionKey: buildAcpDatabaseSessionKey(`agent:main:acp:${name}`, "main"),
    lifecycleRevision: "generation",
    updatedAt: 100,
    meta: metadata(value),
  });
  db.runTransaction(() =>
    executeSqliteQuerySync(db, getAcpSessionKysely(db).insertInto("acp_sessions").values(row)),
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

function expectRows(rows: unknown, ...names: (string | null)[]) {
  expect(rows).toMatchObject(
    names.map((name) => (name === null ? null : { runtime_session_name: name })),
  );
}

function acpReader(store: StoreFixture, ...names: string[]) {
  const input = commandFor(...names);
  const reader = store.open();
  const read = () => readAcpSessionCommand(reader, input).rows;
  return {
    reader,
    read,
    snapshot: (body: () => unknown = read) => runSqliteReadSnapshotSync(reader, body),
    published: () => readPublishedAcpSessionRows(store.pathname, input.entries),
  };
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
      seedAcp(state.writer, "published", "initial");
      const { reader, read, snapshot, published } = acpReader(state, "published", "absent");
      using query = vi.spyOn(reader, "query");
      using exec = vi.spyOn(reader, "exec");
      const metadataReads = () =>
        query.mock.calls.filter(([sql]) => /\b(?:from|join)\s+"?acp_sessions\b/iu.test(sql));
      snapshot(() => {
        expectRows(snapshot(read), "initial", null);
        expect(published()).toBeUndefined();
      });
      expect(exec.mock.calls).toEqual([
        ["BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY"],
        ["ROLLBACK"],
      ]);
      expect(reader.isTransaction).toBe(false);
      expect(metadataReads()).toHaveLength(1);
      expectRows(published(), "initial", null);
      query.mockClear();
      const revision = readSqliteDatabaseWriteRevision(reader);
      writeAcp(state.writer, "absent", "created");
      expect(readSqliteDatabaseWriteRevision(reader)).not.toBe(revision);
      expectRows(snapshot(), "initial", "created");
      writeAcp(state.writer, "published", null);
      expectRows(snapshot(), null, "created");
      expect(metadataReads()).toHaveLength(0);
    });
  });

  it.each(["callback", "close"] as const)(
    "discards ACP facts after a failed snapshot %s",
    (failureAt) => {
      withEngineStoreAdmission(() => {
        if (failureAt === "callback") {
          seedAcp(state.writer, failureAt, "durable");
        }
        const { reader, read, snapshot, published } = acpReader(
          state,
          failureAt,
          `${failureAt}:absent`,
        );
        const expected = failureAt === "callback" ? ["durable", null] : [null, null];
        const failure = new Error("snapshot failure");
        using close =
          failureAt === "close" ? failAfterStatement(reader, "ROLLBACK", failure) : undefined;
        expect(() =>
          snapshot(() => {
            expectRows(read(), ...expected);
            if (failureAt === "callback") {
              throw failure;
            }
          }),
        ).toThrow(failure.message);
        expect(published()).toBeUndefined();
        close?.mockRestore();
        snapshot();
        expectRows(published(), ...expected);
      });
    },
  );

  it("keeps old ACP snapshots isolated from newer positive and negative postimages", () => {
    withEngineStoreAdmission(() => {
      seedAcp(state.writer, "overlap-positive", "before");
      const { read, snapshot, published } = acpReader(
        state,
        "overlap-positive",
        "overlap-negative",
      );
      snapshot(() => {
        expectRows(read(), "before", null);
        writeAcp(state.writer, "overlap-positive", null);
        writeAcp(state.writer, "overlap-negative", "after");
        expectRows(published(), null, "after");
        expectRows(read(), "before", null);
      });
      expectRows(published(), null, "after");
      expectRows(snapshot(), null, "after");
    });
  });

  it.each([
    { initial: "before", updated: "after" },
    { initial: undefined, updated: "created" },
  ])(
    "refreshes cached session rows between snapshots ($initial -> $updated)",
    ({ initial, updated }) => {
      withEngineStoreAdmission(() => {
        const agent = openStore(agentEngineSchema);
        const key = `agent:main:read-facts:${updated}`;
        const insert = (sessionId: string) =>
          agent.writer.runTransaction(() =>
            agent.writer
              .prepare(
                "INSERT INTO session_nodes (session_key, current_session_id, entry_json, updated_at) VALUES (?, ?, ?, ?)",
              )
              .run(key, sessionId, JSON.stringify({ sessionId, updatedAt: 100 }), 100),
          );
        if (initial) {
          insert(initial);
        }
        const reader = agent.open();
        const queries = getExactSessionEntryQueries(reader);
        using query = vi.spyOn(reader, "query");
        const rowReads = () =>
          query.mock.calls.filter(([sql]) => /\bfrom\s+"?session_nodes\b/iu.test(sql));
        const expectRow = (id: string | undefined) => {
          expect(queries.row(key)).toEqual(
            id === undefined ? undefined : expect.objectContaining({ current_session_id: id }),
          );
        };
        runSqliteReadSnapshotSync(reader, () => {
          expectRow(initial);
          expectRow(initial);
          if (initial) {
            agent.writer.runTransaction(() =>
              agent.writer
                .prepare("UPDATE session_nodes SET current_session_id = ? WHERE session_key = ?")
                .run(updated, key),
            );
          } else {
            insert(updated);
          }
          expectRow(initial);
          expect(rowReads()).toHaveLength(1);
        });
        query.mockClear();
        runSqliteReadSnapshotSync(reader, () => {
          expectRow(updated);
          expectRow(updated);
        });
        expect(rowReads()).toHaveLength(1);
      });
    },
  );
});
