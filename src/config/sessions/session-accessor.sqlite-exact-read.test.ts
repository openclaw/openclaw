import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { trackSqliteStatementExecutions } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import * as sqliteQueries from "../../infra/kysely-sync.js";
import { openNodeSqliteDatabase } from "../../infra/node-sqlite.js";
import { readDatabasePathIdentitySync } from "../../infra/sqlite-worker-identity.js";
import {
  closeOpenClawAgentDatabaseByPath,
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { requireNativeSqliteDatabase } from "../../test-utils/native-sqlite.js";
import {
  assignSessionOwner,
  listSessionEntriesReadOnly,
  loadExactSessionEntryReadOnly,
  replaceSessionEntrySync,
} from "./session-accessor.js";
import {
  prepareExactSessionEntryRowReads,
  readSessionChildEntriesInDatabase,
} from "./session-accessor.sqlite-entry-read.js";
import { recordSessionParticipant } from "./session-accessor.sqlite-participants.native.js";
import { ensureTranscriptSessionRoot } from "./session-accessor.sqlite-transcript-state.js";
import { assertCapturedSessionEntryReadSource } from "./session-entry-read-source.js";

const autoTempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
});

describe("exact SQLite session reads", () => {
  it("checks captured database birthtime even without an open owner handle", () => {
    const filename = path.join(
      autoTempDirs.make("openclaw-read-source-identity-"),
      "source.sqlite",
    );
    new DatabaseSync(filename).close();
    const identity = readDatabasePathIdentitySync(filename);
    const source = {
      agentId: "main",
      path: filename,
      databaseIdentity: identity.key.slice("file:".length),
      databaseBirthtime: identity.birthtime,
    };
    expect(() => assertCapturedSessionEntryReadSource(source)).not.toThrow();
    expect(() =>
      assertCapturedSessionEntryReadSource({
        ...source,
        databaseBirthtime: identity.birthtime === "0" ? "1" : "0",
      }),
    ).toThrow("file identity changed");
  });

  it.each([
    { projection: "full", cohort: false },
    { projection: "list", cohort: false },
    { projection: "full", cohort: true },
    { projection: "list", cohort: true },
  ] as const)(
    "decodes a selected $projection row once for its entry and canonical validation (cohort=$cohort)",
    ({ projection, cohort }) => {
      const env = { OPENCLAW_STATE_DIR: autoTempDirs.make("openclaw-exact-read-decode-") };
      const scope = { agentId: "main", env, sessionKey: "agent:main:decode-once" };
      const skillsSnapshot = { prompt: "saved prompt", skills: [] };
      const sessionDiffBaseline = {
        version: 1 as const,
        sessionId: "decode-once",
        root: "/synthetic/workspace",
        files: [{ path: "fixture.ts", fingerprint: "x".repeat(32_768) }],
      };
      replaceSessionEntrySync(scope, {
        sessionId: "decode-once",
        updatedAt: 1,
        skillsSnapshot,
        sessionDiffBaseline,
      });
      assignSessionOwner(scope, {
        owner: { type: "agent", id: "column-owner" },
        assignedBy: { type: "agent", id: "assigner" },
        assignedAt: 2,
      });
      recordSessionParticipant(scope, {
        identity: { type: "profile", id: "participant" },
        promptedAt: 3,
      });
      loadExactSessionEntryReadOnly({ ...scope, projection });
      const parse = vi.spyOn(JSON, "parse");
      try {
        const selected = cohort
          ? prepareExactSessionEntryRowReads(
              openOpenClawAgentDatabase(scope),
              [scope.sessionKey],
              projection,
              "canonical",
            )(scope.sessionKey)
          : loadExactSessionEntryReadOnly({ ...scope, projection });
        expect(selected?.entry).toMatchObject({
          sessionId: "decode-once",
          updatedAt: 1,
          owner: { actor: { type: "agent", id: "column-owner" } },
          participants: [{ identity: { type: "profile", id: "participant" } }],
          participantCount: 1,
        });
        expect(selected?.entry.skillsSnapshot).toEqual(
          projection === "full" ? skillsSnapshot : undefined,
        );
        expect(selected?.entry.sessionDiffBaseline).toEqual(
          projection === "full" ? sessionDiffBaseline : undefined,
        );
        expect(parse.mock.calls.filter(([text]) => text.includes('"updatedAt":1'))).toHaveLength(1);
      } finally {
        parse.mockRestore();
      }
    },
  );

  it.each(["cold", "warm"] as const)(
    "keeps the exact lookup coherent across a concurrent commit (%s)",
    (admission) => {
      const env = { OPENCLAW_STATE_DIR: autoTempDirs.make("openclaw-exact-read-snapshot-") };
      const scope = { agentId: "main", env, sessionKey: "agent:main:snapshot" };
      const entry = { sessionId: "snapshot", updatedAt: 1, label: "before" };
      replaceSessionEntrySync(scope, entry);
      const original = openOpenClawAgentDatabase(scope);
      closeOpenClawAgentDatabaseByPath(original.path);
      const database = openOpenClawAgentDatabase(scope);
      const read = (sessionKey = scope.sessionKey) =>
        loadExactSessionEntryReadOnly({ ...scope, sessionKey });
      if (admission !== "cold") {
        expect(read()?.entry.label).toBe("before");
        // Keep admission warm while evicting the target row so the race reaches SQL.
        expect(read("agent:main:missing")).toBeUndefined();
      }
      const sibling = openNodeSqliteDatabase(database.path);
      const nativeDb = requireNativeSqliteDatabase(database.db);
      sqliteQueries.clearNodeSqliteKyselyCacheForDatabase(nativeDb);
      const prepare = nativeDb.prepare.bind(nativeDb);
      let selectedInTransaction: boolean | undefined;
      const prepareSpy = vi.spyOn(nativeDb, "prepare").mockImplementation((sql) => {
        const statement = prepare(sql);
        if (
          selectedInTransaction === undefined &&
          /from "session_nodes"/i.test(sql) &&
          /where (?:"session_nodes"\.)?"session_key" (?:=|in) /i.test(sql)
        ) {
          selectedInTransaction = database.db.isTransaction;
          sibling
            .prepare(
              "UPDATE session_nodes SET entry_json = ?, label = 'after' WHERE session_key = ?",
            )
            .run(JSON.stringify({ ...entry, label: "after" }), scope.sessionKey);
          sibling
            .prepare("UPDATE session_nodes SET entry_valid = 1 WHERE session_key = ?")
            .run(scope.sessionKey);
        }
        return statement;
      });
      try {
        expect(read()?.entry.label).toBe("after");
        expect(selectedInTransaction).toBe(false);
        expect(database.db.isTransaction).toBe(false);
        expect(read()?.entry.label).toBe("after");
      } finally {
        prepareSpy.mockRestore();
        sibling.close();
      }
    },
  );

  it.each(["same connection", "sibling connection"] as const)(
    "observes managed node and participant writes from %s after warming list metadata",
    (writer) => {
      const env = { OPENCLAW_STATE_DIR: autoTempDirs.make("openclaw-exact-read-invalidate-") };
      const scope = { agentId: "main", env, sessionKey: "agent:main:target" };
      replaceSessionEntrySync(scope, { sessionId: "target", updatedAt: 1, label: "before" });
      recordSessionParticipant(scope, { identity: { type: "profile", id: "before" } });
      listSessionEntriesReadOnly({ ...scope, projection: "list" });
      const database = openOpenClawAgentDatabase(scope);
      const connection =
        writer === "same connection" ? database.db : openNodeSqliteDatabase(database.path);
      const read = () => loadExactSessionEntryReadOnly({ ...scope, projection: "list" });
      try {
        connection
          .prepare("UPDATE session_nodes SET entry_json = ? WHERE session_key = ?")
          .run(
            JSON.stringify({ sessionId: "target", updatedAt: 1, label: "after" }),
            scope.sessionKey,
          );
        expect(read()).toMatchObject({ entry: { label: "after" } });
        listSessionEntriesReadOnly({ ...scope, projection: "list" });
        connection
          .prepare("UPDATE session_participants SET actor_id = ? WHERE session_key = ?")
          .run("after", scope.sessionKey);
        expect(read()).toMatchObject({
          entry: { participants: [{ identity: { type: "profile", id: "after" } }] },
        });
      } finally {
        if (connection !== database.db) {
          connection.close();
        }
      }
    },
  );

  it.each(["current_session_id", "updated_at", "malformed", "delivery", "lineage"] as const)(
    "keeps per-key %s errors after an intervening list reload",
    (corruption) => {
      const env = { OPENCLAW_STATE_DIR: autoTempDirs.make("openclaw-exact-read-identity-") };
      const scope = { agentId: "main", env, projection: "list" as const };
      const healthy = "agent:main:healthy";
      const broken = "agent:main:matrix:group:!room:example.org";
      for (const sessionKey of [healthy, broken]) {
        replaceSessionEntrySync({ ...scope, sessionKey }, { sessionId: sessionKey, updatedAt: 1 });
      }
      listSessionEntriesReadOnly(scope);
      const database = openOpenClawAgentDatabase(scope);
      if (corruption === "lineage") {
        database.db
          .prepare("UPDATE session_nodes SET parent_session_key = ? WHERE session_key = ?")
          .run("agent:main:divergent", broken);
        const readRow = prepareExactSessionEntryRowReads(
          database,
          [healthy, broken],
          "list",
          "canonical",
        );
        expect(readRow(healthy)?.entry.sessionId).toBe(healthy);
        expect(() => readRow(broken)).toThrow("invalid persisted session row");
        return;
      }
      if (corruption === "current_session_id" || corruption === "updated_at") {
        database.db
          .prepare(`UPDATE session_nodes SET ${corruption} = ? WHERE session_key = ?`)
          .run(corruption === "current_session_id" ? "mismatched" : 2, broken);
      } else {
        const json =
          corruption === "malformed"
            ? "{"
            : JSON.stringify({
                sessionId: broken,
                updatedAt: 1,
                delivery: {
                  kind: "external",
                  route: {
                    channel: "matrix",
                    accountId: "work",
                    target: { to: "!Room:example.org" },
                  },
                  context: { channel: "matrix", accountId: "work", to: "!Room:example.org" },
                  origin: { provider: "matrix", to: "!Room:example.org", accountId: "work" },
                },
              });
        database.db
          .prepare("UPDATE session_nodes SET entry_json = ? WHERE session_key = ?")
          .run(json, broken);
      }
      if (corruption === "delivery") {
        expect(() => listSessionEntriesReadOnly(scope)).toThrow(/non-canonical persisted row/);
      } else {
        listSessionEntriesReadOnly(scope);
      }
      let originalError: unknown;
      try {
        loadExactSessionEntryReadOnly({ ...scope, sessionKey: broken });
      } catch (error) {
        originalError = error;
      }
      expect(originalError).toMatchObject({ code: "SESSION_CANONICAL_KEY_MIGRATION_REQUIRED" });
      const readRow = prepareExactSessionEntryRowReads(
        database,
        [healthy, broken, "agent:main:missing"],
        "list",
        "canonical",
      );
      expect(readRow(healthy)?.entry.sessionId).toBe(healthy);
      expect(readRow("agent:main:missing")).toBeUndefined();
      expect(() => readRow(broken)).toThrow(originalError);
    },
  );

  it("reads only the retained target without a listing cache", () => {
    const env = { OPENCLAW_STATE_DIR: autoTempDirs.make("openclaw-exact-read-uncached-") };
    const scope = { agentId: "main", env, sessionKey: "agent:main:target" };
    replaceSessionEntrySync(scope, { sessionId: "target", updatedAt: 1 });
    replaceSessionEntrySync(
      { ...scope, sessionKey: "agent:main:unrelated" },
      { sessionId: "unrelated", updatedAt: 1, label: "unrelated payload ".repeat(1024) },
    );
    const database = openOpenClawAgentDatabase(scope);
    const queries = trackSqliteStatementExecutions(
      requireNativeSqliteDatabase(database.db),
      ["entries"],
      (sql) => (/from\s+"session_nodes"/i.test(sql) ? "entries" : null),
    );
    try {
      expect(loadExactSessionEntryReadOnly({ ...scope, projection: "list" })).toMatchObject({
        entry: { sessionId: "target" },
      });
      expect(queries.rowCounts.entries).toBe(1);
      expect(queries.textBytes.entries).toBeLessThan(1024);
    } finally {
      queries.restore();
    }
  });

  it("reads committed entries through the companion while the cached writer has a transaction", () => {
    const env = { OPENCLAW_STATE_DIR: autoTempDirs.make("openclaw-exact-read-committed-") };
    const scope = { agentId: "main", env, sessionKey: "agent:main:target" };
    replaceSessionEntrySync(scope, { sessionId: "target", updatedAt: 1, label: "committed" });
    listSessionEntriesReadOnly({ ...scope, projection: "list" });
    const read = () => loadExactSessionEntryReadOnly({ ...scope, projection: "list" });
    runOpenClawAgentWriteTransaction((database) => {
      database.db
        .prepare("UPDATE session_nodes SET entry_json = ? WHERE session_key = ?")
        .run(
          JSON.stringify({ sessionId: "target", updatedAt: 1, label: "next" }),
          scope.sessionKey,
        );
      expect(read()).toMatchObject({ entry: { label: "committed" } });
    }, scope);
    expect(read()).toMatchObject({ entry: { label: "next" } });
  });

  it.each(["full", "list"] as const)(
    "preserves native key bindings in %s exact reads",
    (projection) => {
      const env = { OPENCLAW_STATE_DIR: autoTempDirs.make("openclaw-exact-read-unicode-") };
      const scope = { agentId: "main", env };
      const storedKey = "agent:main:replacement-\ufffd";
      replaceSessionEntrySync(
        { ...scope, sessionKey: storedKey },
        { sessionId: "replacement", updatedAt: 1 },
      );
      recordSessionParticipant(
        { ...scope, sessionKey: storedKey },
        { identity: { type: "profile", id: "person" }, promptedAt: 1 },
      );
      const keys = [
        "agent:main:replacement-\ud800",
        "agent:main:replacement-\udc00",
        storedKey,
        "agent:main:replacement-\ud800",
      ];
      const expectedEntry = {
        sessionId: "replacement",
        participantCount: 1,
        participants: [{ identity: { type: "profile", id: "person" } }],
      };
      for (const sessionKey of keys) {
        expect(loadExactSessionEntryReadOnly({ ...scope, sessionKey, projection })).toMatchObject({
          entry: expectedEntry,
        });
      }
    },
  );

  it.each(["entries", "participants"] as const)(
    "isolates native SQLite conversion errors in exact %s reads",
    (table) => {
      const env = { OPENCLAW_STATE_DIR: autoTempDirs.make("openclaw-exact-read-conversion-") };
      const scope = { agentId: "main", env };
      const keys = ["agent:main:before", "agent:main:broken", "agent:main:after"] as const;
      const retained = "agent:main:retained";
      for (const sessionKey of keys) {
        replaceSessionEntrySync({ ...scope, sessionKey }, { sessionId: sessionKey, updatedAt: 1 });
        recordSessionParticipant(
          { ...scope, sessionKey },
          { identity: { type: "profile", id: sessionKey }, promptedAt: 1 },
        );
      }
      runOpenClawAgentWriteTransaction((database) => {
        ensureTranscriptSessionRoot(
          database,
          { ...scope, sessionKey: retained, sessionId: retained },
          1,
        );
      }, scope);
      for (const projection of ["full", "list"] as const) {
        for (const sessionKey of keys) {
          expect(
            loadExactSessionEntryReadOnly({ ...scope, sessionKey, projection })?.entry.sessionId,
          ).toBe(sessionKey);
        }
      }
      const database = openOpenClawAgentDatabase(scope);
      for (const sessionKey of [keys[0], retained]) {
        database.db
          .prepare(
            "INSERT INTO board_tabs (session_key, tab_id, title, position, created_by, revision) VALUES (?, 'tab', 'Board', 0, 'user', 0)",
          )
          .run(sessionKey);
      }
      database.db
        .prepare(
          table === "entries"
            ? "UPDATE session_nodes SET updated_at = ? WHERE session_key = ?"
            : "UPDATE session_participants SET contribution_count = ? WHERE session_key = ?",
        )
        .run(9007199254740993n, keys[1]);
      for (const projection of ["full", "list"] as const) {
        let originalError: unknown;
        try {
          loadExactSessionEntryReadOnly({ ...scope, sessionKey: keys[1], projection });
        } catch (error) {
          originalError = error;
        }
        expect(originalError).toMatchObject({ code: "ERR_OUT_OF_RANGE" });
        const readRow = prepareExactSessionEntryRowReads(
          database,
          [...keys, retained],
          projection,
          "canonical",
          { includeBoardPresence: true },
        );
        expect(readRow(keys[0])?.entry.sessionId).toBe(keys[0]);
        expect(readRow(keys[0])?.row.board_present).toBe(1);
        expect(() => readRow(keys[1])).toThrow(originalError);
        expect(readRow(keys[2])?.entry.sessionId).toBe(keys[2]);
        expect(readRow(keys[2])?.row.board_present).toBe(0);
        expect(readRow(retained)).toBeUndefined();
      }
    },
  );

  it("uses lineage indexes for direct child discovery with stale clustered statistics", () => {
    const env = { OPENCLAW_STATE_DIR: autoTempDirs.make("openclaw-child-query-plan-") };
    const scope = { agentId: "main", env };
    const parent = "agent:main:indexed-parent";
    const olderParent = (index: number) => `agent:main:older-parent-${index}`;
    const otherParent = olderParent(0);
    const childKey = (name: string) => `agent:main:child-${name}`;
    const seedEntry = (
      sessionId: string,
      lineage: { parentSessionKey?: string; spawnedBy?: string } = {},
    ) =>
      replaceSessionEntrySync(
        { ...scope, sessionKey: `agent:main:${sessionId}` },
        { sessionId, updatedAt: 1, ...lineage },
      );
    runOpenClawAgentWriteTransaction(() => {
      for (let index = 0; index < 8; index += 1) {
        seedEntry(`older-parent-${index}`);
      }
      for (let index = 0; index < 438; index += 1) {
        seedEntry(`older-child-${index}`, {
          parentSessionKey: olderParent(index % 8),
          ...(index < 73 ? { spawnedBy: olderParent(index % 7) } : {}),
        });
      }
    }, scope);
    const database = openOpenClawAgentDatabase(scope);
    // Retained sessions cluster under a few parents. Analyze 446 rows before
    // new collectors and unrelated writes grow the store to 555 rows.
    database.db.exec("ANALYZE");
    const children = [
      ["z-parent", { parentSessionKey: parent, spawnedBy: otherParent }],
      ["a-spawn", { parentSessionKey: otherParent, spawnedBy: parent }],
      ["m-both", { parentSessionKey: parent, spawnedBy: parent }],
      ["b-parent", { parentSessionKey: parent }],
      ["y-spawn", { parentSessionKey: otherParent, spawnedBy: parent }],
      ["c-parent", { parentSessionKey: parent }],
      ["x-spawn", { parentSessionKey: otherParent, spawnedBy: parent }],
      ["d-parent", { parentSessionKey: parent }],
      ["w-spawn", { parentSessionKey: otherParent, spawnedBy: parent }],
    ] as const;
    runOpenClawAgentWriteTransaction(() => {
      seedEntry("indexed-parent", { parentSessionKey: parent, spawnedBy: parent });
      for (const [name, lineage] of children) {
        replaceSessionEntrySync(
          { ...scope, sessionKey: childKey(name) },
          { sessionId: name, updatedAt: 1, ...lineage },
        );
      }
      for (let index = 0; index < 99; index += 1) {
        seedEntry(`later-unrelated-${index}`, {
          ...(index < 96 ? { parentSessionKey: olderParent(index % 8) } : {}),
          ...(index < 3 ? { spawnedBy: olderParent(index) } : {}),
        });
      }
    }, scope);
    const queries = vi.spyOn(sqliteQueries, "executeSqliteQuerySync");
    try {
      const result = readSessionChildEntriesInDatabase(database, parent);
      const names = [
        "a-spawn",
        "b-parent",
        "c-parent",
        "d-parent",
        "m-both",
        "w-spawn",
        "x-spawn",
        "y-spawn",
        "z-parent",
      ];
      expect(
        result.map(({ sessionKey, entry }) => ({ sessionKey, sessionId: entry.sessionId })),
      ).toEqual(names.map((name) => ({ sessionKey: childKey(name), sessionId: name })));
      const childQueries = queries.mock.calls
        .map(([readDatabase, query]) => ({ readDatabase, ...query.compile() }))
        .filter(
          ({ sql }) => /"parent_session_key"\s+in/u.test(sql) && /"spawned_by"\s+in/u.test(sql),
        );
      expect(childQueries).toHaveLength(1);
      const childQuery = childQueries[0]!;
      const parameters = childQuery.parameters.map((parameter) => {
        if (typeof parameter !== "string") {
          throw new Error("Expected a string child-query binding");
        }
        return parameter;
      });
      if (!(childQuery.readDatabase instanceof DatabaseSync)) {
        throw new Error("Expected a SQLite connection for the query-plan assertion");
      }
      const plan = childQuery.readDatabase
        .prepare(`EXPLAIN QUERY PLAN ${childQuery.sql}`)
        .all(...parameters)
        .map(({ detail }) => detail);
      expect(plan).not.toContainEqual(expect.stringMatching(/\bSCAN session_nodes\b/u));
      for (const index of [
        "idx_agent_session_nodes_parent_session_key",
        "idx_agent_session_nodes_spawned_by",
      ]) {
        expect(plan).toContainEqual(
          expect.stringMatching(new RegExp(`\\bSEARCH\\b.*\\b${index}\\b`, "u")),
        );
      }
    } finally {
      queries.mockRestore();
    }
  });

  it.each(["full", "list"] as const)(
    "does not read malformed placeholder participants in %s exact and child reads",
    (projection) => {
      const env = { OPENCLAW_STATE_DIR: autoTempDirs.make("openclaw-exact-read-placeholder-") };
      const scope = { agentId: "main", env, projection };
      const parent = "agent:main:parent";
      const healthy = "agent:main:healthy";
      const retained = "agent:main:retained";
      replaceSessionEntrySync(
        { ...scope, sessionKey: healthy },
        { sessionId: healthy, updatedAt: 1, parentSessionKey: parent },
      );
      runOpenClawAgentWriteTransaction((database) => {
        ensureTranscriptSessionRoot(
          database,
          { ...scope, sessionKey: retained, sessionId: retained },
          1,
        );
      }, scope);
      const database = openOpenClawAgentDatabase(scope);
      database.db
        .prepare("UPDATE session_nodes SET parent_session_key = ? WHERE session_key = ?")
        .run(parent, retained);
      expect(
        loadExactSessionEntryReadOnly({ ...scope, sessionKey: healthy })?.entry.sessionId,
      ).toBe(healthy);
      expect(loadExactSessionEntryReadOnly({ ...scope, sessionKey: retained })).toBeUndefined();
      database.db
        .prepare(
          "INSERT INTO session_participants (session_key, identity_namespace, actor_id, contribution_count, first_prompted_at, last_prompted_at) VALUES (?, ?, ?, ?, 1, 1)",
        )
        .run(retained, "invalid namespace", "unused", 9007199254740993n);
      expect(loadExactSessionEntryReadOnly({ ...scope, sessionKey: retained })).toBeUndefined();
      const readRow = prepareExactSessionEntryRowReads(
        database,
        [retained, healthy],
        projection,
        "canonical",
      );
      expect(readRow(retained)).toBeUndefined();
      expect(readRow(healthy)?.entry.sessionId).toBe(healthy);
      expect(readSessionChildEntriesInDatabase(database, parent, scope.projection)).toMatchObject([
        { sessionKey: healthy, entry: { sessionId: healthy } },
      ]);
    },
  );
});
