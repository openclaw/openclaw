import { afterEach, describe, expect, it, vi } from "vitest";
import { trackSqliteStatementExecutions } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import * as sqliteQueries from "../../infra/kysely-sync.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import {
  listSessionChildEntriesReadOnly,
  loadExactSessionEntryCandidatesReadOnlyBatch,
  loadExactSessionEntryReadOnly,
  recordSessionParticipant,
  replaceSessionEntrySync,
} from "./session-accessor.js";
import { ensureTranscriptSessionRoot } from "./session-accessor.sqlite-transcript-state.js";

const autoTempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
});

describe("exact SQLite session batches", () => {
  it.each(["full", "list"] as const)(
    "batches fresh entry and participant reads while preserving %s results",
    (projection) => {
      const env = { OPENCLAW_STATE_DIR: autoTempDirs.make("openclaw-exact-read-batch-") };
      const scope = { agentId: "main", env };
      const keys = Array.from({ length: 24 }, (_, index) => `agent:main:batch-${index}`);
      for (const [index, sessionKey] of keys.entries()) {
        replaceSessionEntrySync(
          { ...scope, sessionKey },
          { sessionId: `batch-${index}`, updatedAt: index + 1, label: `before-${index}` },
        );
        recordSessionParticipant(
          { ...scope, sessionKey },
          { identity: { type: "profile", id: `profile-${index}` }, promptedAt: index + 1 },
        );
      }
      const read = () =>
        loadExactSessionEntryCandidatesReadOnlyBatch(
          [
            [keys[23]!, keys[0]!, keys[23]!],
            ...keys.map((key) => [key]),
            ["agent:main:missing"],
          ].map((sessionKeys) => ({ agentId: scope.agentId, env, sessionKeys, projection })),
        );
      expect(read().every((result) => result.ok)).toBe(true);
      const database = openOpenClawAgentDatabase(scope);
      // Fresh exact reads must observe changes after an earlier projection warmed its caches.
      database.db
        .prepare("UPDATE session_nodes SET entry_json = ? WHERE session_key = ?")
        .run(JSON.stringify({ sessionId: "batch-0", updatedAt: 1, label: "fresh" }), keys[0]!);
      database.db
        .prepare("UPDATE session_participants SET actor_id = ? WHERE session_key = ?")
        .run("fresh-profile", keys[0]!);
      const queries = trackSqliteStatementExecutions(
        database.db,
        ["entries", "participants"],
        (sql) => {
          if (/from\s+"session_nodes"/i.test(sql)) {
            return "entries";
          }
          if (/from\s+"session_participants"/i.test(sql)) {
            return "participants";
          }
          return null;
        },
      );
      try {
        const result = read();
        expect(result[0]).toMatchObject({
          ok: true,
          value: [
            { sessionKey: keys[23], entry: { sessionId: "batch-23" } },
            { sessionKey: keys[0], entry: { sessionId: "batch-0", label: "fresh" } },
            { sessionKey: keys[23], entry: { sessionId: "batch-23" } },
          ],
        });
        for (const [index, sessionKey] of keys.entries()) {
          expect(result[index + 1]).toMatchObject({
            ok: true,
            value: [
              {
                sessionKey,
                entry: {
                  participants: [
                    {
                      identity: {
                        type: "profile",
                        id: index === 0 ? "fresh-profile" : `profile-${index}`,
                      },
                    },
                  ],
                },
              },
            ],
          });
        }
        expect(result.at(-1)).toEqual({ ok: true, value: [] });
        expect(queries.counts).toEqual({ entries: 1, participants: 1 });
      } finally {
        queries.restore();
      }
    },
  );

  it.each(["full", "list"] as const)(
    "preserves native key bindings in %s exact batches",
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
      const keys = ["agent:main:replacement-\ud800", "agent:main:replacement-\udc00", storedKey];
      const expectedEntry = {
        sessionId: "replacement",
        participantCount: 1,
        participants: [{ identity: { type: "profile", id: "person" } }],
      };
      expect(
        loadExactSessionEntryReadOnly({ ...scope, sessionKey: keys[0]!, projection }),
      ).toMatchObject({ entry: expectedEntry });
      expect(
        loadExactSessionEntryCandidatesReadOnlyBatch([
          { agentId: scope.agentId, env, projection, sessionKeys: keys },
        ]),
      ).toMatchObject([
        { ok: true, value: keys.map((sessionKey) => ({ sessionKey, entry: expectedEntry })) },
      ]);
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
      const requests = [
        [keys[0]],
        [keys[1]],
        [keys[2]],
        ["agent:main:missing"],
        [retained],
        [keys[2], keys[0], keys[2]],
        [keys[0], keys[1]],
      ];
      const read = (projection: "full" | "list") =>
        loadExactSessionEntryCandidatesReadOnlyBatch(
          requests.map((sessionKeys) => ({ agentId: scope.agentId, env, sessionKeys, projection })),
        );
      for (const projection of ["full", "list"] as const) {
        expect(read(projection).every((result) => result.ok)).toBe(true);
      }
      const database = openOpenClawAgentDatabase(scope);
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
        const entry = (sessionKey: string) => ({
          sessionKey,
          entry: { sessionId: sessionKey, participantCount: 1 },
        });
        expect(read(projection)).toMatchObject([
          { ok: true, value: [entry(keys[0])] },
          { ok: false, error: originalError },
          { ok: true, value: [entry(keys[2])] },
          { ok: true, value: [] },
          { ok: true, value: [] },
          { ok: true, value: [entry(keys[2]), entry(keys[0]), entry(keys[2])] },
          { ok: false, error: originalError },
        ]);
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
      const result = listSessionChildEntriesReadOnly({ ...scope, sessionKey: parent });
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
          ({ sql }) => /"parent_session_key"\s*=/u.test(sql) && /"spawned_by"\s*=/u.test(sql),
        );
      expect(childQueries).toHaveLength(1);
      const childQuery = childQueries[0]!;
      const parameters = childQuery.parameters.map((parameter) => {
        if (typeof parameter !== "string") {
          throw new Error("Expected a string child-query binding");
        }
        return parameter;
      });
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
      const read = (sessionKeys: string[]) =>
        loadExactSessionEntryCandidatesReadOnlyBatch(
          sessionKeys.map((sessionKey) => ({
            agentId: scope.agentId,
            env,
            projection,
            sessionKeys: [sessionKey],
          })),
        );
      expect(read([healthy, retained]).every((result) => result.ok)).toBe(true);
      database.db
        .prepare(
          "INSERT INTO session_participants (session_key, identity_namespace, actor_id, contribution_count, first_prompted_at, last_prompted_at) VALUES (?, ?, ?, ?, 1, 1)",
        )
        .run(retained, "invalid namespace", "unused", 9007199254740993n);
      expect(read([retained])).toEqual([{ ok: true, value: [] }]);
      expect.soft(read([healthy, retained])).toMatchObject([
        { ok: true, value: [{ sessionKey: healthy, entry: { sessionId: healthy } }] },
        { ok: true, value: [] },
      ]);
      expect(listSessionChildEntriesReadOnly({ ...scope, sessionKey: parent })).toMatchObject([
        { sessionKey: healthy, entry: { sessionId: healthy } },
      ]);
    },
  );
});
