import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { trackSqliteStatementExecutions } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import * as sqliteQueries from "../../infra/kysely-sync.js";
import { invalidateOpenClawAgentDatabaseValidation } from "../../state/openclaw-agent-db-validation-cache.js";
import {
  closeOpenClawAgentDatabaseByPath,
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import {
  assignSessionOwner,
  listSessionChildEntriesReadOnly,
  listSessionEntriesReadOnly,
  loadExactSessionEntryCandidatesReadOnlyBatch,
  loadExactSessionEntryReadOnly,
  replaceSessionEntrySync,
} from "./session-accessor.js";
import { captureSessionEntryRead } from "./session-accessor.sqlite-entry-read-lifetime.js";
import { loadExactSessionEntryCandidates } from "./session-accessor.sqlite-exact-read.js";
import { recordSessionParticipant } from "./session-accessor.sqlite-participants.native.js";
import { ensureTranscriptSessionRoot } from "./session-accessor.sqlite-transcript-state.js";
import {
  assertCanonicalSqliteSessionKeysCurrent,
  setCanonicalSqliteSessionMainKey,
} from "./session-canonical-key.js";

const autoTempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
});

describe("exact SQLite session batches", () => {
  it.each(
    (["single", "batch"] as const).flatMap((reader) =>
      (["cold", "warm", "policy", "receipt"] as const).map((admission) => ({
        reader,
        admission,
      })),
    ),
  )(
    "keeps the $reader exact lookup coherent across a concurrent commit ($admission)",
    ({ reader, admission }) => {
      const env = { OPENCLAW_STATE_DIR: autoTempDirs.make("openclaw-exact-read-snapshot-") };
      const scope = { agentId: "main", env, sessionKey: "agent:main:snapshot" };
      const entry = { sessionId: "snapshot", updatedAt: 1, label: "before" };
      replaceSessionEntrySync(scope, entry);
      const original = openOpenClawAgentDatabase(scope);
      closeOpenClawAgentDatabaseByPath(original.path);
      const database = openOpenClawAgentDatabase(scope);
      const read = () => {
        if (reader === "single") {
          return loadExactSessionEntryReadOnly(scope);
        }
        const result = loadExactSessionEntryCandidatesReadOnlyBatch([
          { ...scope, sessionKeys: [scope.sessionKey] },
        ])[0]!;
        if (!result.ok) {
          throw result.error;
        }
        return result.value[0];
      };
      if (admission !== "cold") {
        expect(read()?.entry.label).toBe("before");
      }
      if (admission === "policy") {
        setCanonicalSqliteSessionMainKey(database, "custom");
      } else if (admission === "receipt") {
        invalidateOpenClawAgentDatabaseValidation(database.path);
      }
      const external = new DatabaseSync(database.path);
      sqliteQueries.clearNodeSqliteKyselyCacheForDatabase(database.db);
      const prepare = database.db.prepare.bind(database.db);
      let selectedInTransaction: boolean | undefined;
      const prepareSpy = vi.spyOn(database.db, "prepare").mockImplementation((sql) => {
        const statement = prepare(sql);
        if (
          selectedInTransaction === undefined &&
          /from "session_nodes"/i.test(sql) &&
          /where (?:"session_nodes"\.)?"session_key" (?:=|in) /i.test(sql)
        ) {
          selectedInTransaction = database.db.isTransaction;
          external
            .prepare(
              "UPDATE session_nodes SET entry_json = ?, label = 'after' WHERE session_key = ?",
            )
            .run(JSON.stringify({ ...entry, label: "after" }), scope.sessionKey);
          external
            .prepare("UPDATE session_nodes SET entry_valid = 1 WHERE session_key = ?")
            .run(scope.sessionKey);
        }
        return statement;
      });
      try {
        // Single-row validation shares the selected statement; only batch admission pins earlier.
        const pinnedBeforeSelection = reader === "batch" && admission !== "warm";
        expect(read()?.entry.label).toBe(pinnedBeforeSelection ? "before" : "after");
        expect(selectedInTransaction).toBe(pinnedBeforeSelection);
        expect(database.db.isTransaction).toBe(false);
        expect(read()?.entry.label).toBe("after");
      } finally {
        prepareSpy.mockRestore();
        external.close();
      }
    },
  );

  it.each(["single", "batch"] as const)(
    "rolls back failed cold %s admission and restores its private snapshot scope",
    (reader) => {
      const env = {
        OPENCLAW_STATE_DIR: autoTempDirs.make("openclaw-exact-read-failed-admission-"),
      };
      const scope = { agentId: "main", env, sessionKey: "agent:main:snapshot" };
      replaceSessionEntrySync(scope, { sessionId: "snapshot", updatedAt: 1 });
      const original = openOpenClawAgentDatabase(scope);
      closeOpenClawAgentDatabaseByPath(original.path);
      const database = openOpenClawAgentDatabase(scope);
      const failure = new Error("read source callback failed");
      const request = {
        ...scope,
        sessionKeys: [scope.sessionKey],
        onReadSource: () => {
          throw failure;
        },
      };
      if (reader === "single") {
        expect(() => loadExactSessionEntryCandidates({ ...request, readOnly: true })).toThrow(
          failure,
        );
      } else {
        expect(loadExactSessionEntryCandidatesReadOnlyBatch([request])).toEqual([
          { ok: false, error: failure },
        ]);
      }
      expect(database.db.isTransaction).toBe(false);
      database.db
        .prepare("UPDATE session_nodes SET parent_session_key = ? WHERE session_key = ?")
        .run("agent:main:divergent", scope.sessionKey);
      // An ordinary unscoped guard must receive the real validation refusal, not
      // the private retry signal or a receipt leaked from the rolled-back read.
      expect(() => assertCanonicalSqliteSessionKeysCurrent(database)).toThrow(
        "invalid persisted session row",
      );
    },
  );

  it("reuses complete list metadata without rereading saved prompts or sharing mutable entries", () => {
    const env = { OPENCLAW_STATE_DIR: autoTempDirs.make("openclaw-exact-read-cached-") };
    const scope = { agentId: "main", env };
    const keys = Array.from({ length: 4 }, (_, index) => `agent:main:cached-${index}`);
    const savedPrompt = {
      skillsSnapshot: { prompt: "synthetic skill text ".repeat(1024), skills: [] },
      systemPromptReport: {
        source: "run" as const,
        generatedAt: 1,
        systemPrompt: { chars: 20_480, projectContextChars: 0, nonProjectContextChars: 20_480 },
        injectedWorkspaceFiles: [],
        skills: { promptChars: 20_480, entries: [] },
        tools: { listChars: 0, schemaChars: 0, entries: [] },
      },
    };
    for (const [index, sessionKey] of keys.entries()) {
      replaceSessionEntrySync(
        { ...scope, sessionKey },
        {
          sessionId: `cached-${index}`,
          updatedAt: index + 1,
          ...savedPrompt,
        },
      );
      recordSessionParticipant(
        { ...scope, sessionKey },
        { identity: { type: "profile", id: `person-${index}` }, promptedAt: index + 1 },
      );
    }
    expect(listSessionEntriesReadOnly({ ...scope, projection: "list" })).toHaveLength(4);
    const database = openOpenClawAgentDatabase(scope);
    const queries = trackSqliteStatementExecutions(
      database.db,
      ["payload", "identity", "participants"],
      (sql) => {
        if (/from\s+"session_nodes"/i.test(sql)) {
          return /entry_json/i.test(sql) ? "payload" : "identity";
        }
        return /from\s+"session_participants"/i.test(sql) ? "participants" : null;
      },
    );
    const read = () =>
      loadExactSessionEntryCandidatesReadOnlyBatch([
        { ...scope, projection: "list", sessionKeys: [keys[2]!, keys[0]!, keys[2]!] },
        { ...scope, projection: "list", sessionKeys: [keys[1]!] },
      ]);
    try {
      const first = read();
      expect(first[0]).toMatchObject({
        ok: true,
        value: [
          { sessionKey: keys[2], entry: { sessionId: "cached-2" } },
          { sessionKey: keys[0], entry: { sessionId: "cached-0" } },
          { sessionKey: keys[2], entry: { sessionId: "cached-2" } },
        ],
      });
      expect(queries.counts.payload).toBe(0);
      expect(queries.counts.participants).toBe(0);
      expect(queries.rowCounts.identity).toBe(3);
      const selected = first[0];
      if (!selected?.ok) {
        throw new Error("Expected cached exact entries");
      }
      expect(selected.value[0]!.entry.skillsSnapshot).toBeUndefined();
      expect(selected.value[0]!.entry.systemPromptReport).toBeUndefined();
      selected.value[0]!.entry.participants![0]!.identity = { type: "profile", id: "changed" };
      const next = read()[0];
      if (!next?.ok) {
        throw new Error("Expected fresh exact entries");
      }
      expect(next.value[0]).toMatchObject({
        entry: { participants: [{ identity: { type: "profile", id: "person-2" } }] },
      });
      expect(listSessionEntriesReadOnly({ ...scope, projection: "list" })[2]).toMatchObject({
        entry: { participants: [{ identity: { type: "profile", id: "person-2" } }] },
      });
      assignSessionOwner(
        { ...scope, sessionKey: keys[2]! },
        { owner: { type: "agent", id: "research" }, assignedBy: { type: "system", id: "fixture" } },
      );
      recordSessionParticipant(
        { ...scope, sessionKey: keys[2]! },
        { identity: { type: "agent", id: "peer" } },
      );
      expect(read()[0]).toMatchObject({
        ok: true,
        value: expect.arrayContaining([
          {
            sessionKey: keys[2],
            entry: expect.objectContaining({
              owner: expect.objectContaining({ actor: { type: "agent", id: "research" } }),
              participants: expect.arrayContaining([{ identity: { type: "agent", id: "peer" } }]),
            }),
          },
        ]),
      });
    } finally {
      queries.restore();
    }
    for (const projection of ["full", undefined] as const) {
      expect(
        loadExactSessionEntryCandidatesReadOnlyBatch([
          { ...scope, projection, sessionKeys: [keys[2]!] },
        ]),
      ).toMatchObject([{ ok: true, value: [{ entry: savedPrompt }] }]);
    }
  });

  it.each(["same connection", "external connection"] as const)(
    "observes raw node and participant changes from %s after warming list metadata",
    (writer) => {
      const env = { OPENCLAW_STATE_DIR: autoTempDirs.make("openclaw-exact-read-invalidate-") };
      const scope = { agentId: "main", env, sessionKey: "agent:main:target" };
      replaceSessionEntrySync(scope, { sessionId: "target", updatedAt: 1, label: "before" });
      recordSessionParticipant(scope, { identity: { type: "profile", id: "before" } });
      listSessionEntriesReadOnly({ ...scope, projection: "list" });
      const database = openOpenClawAgentDatabase(scope);
      const connection =
        writer === "same connection" ? database.db : new DatabaseSync(database.path);
      const read = () =>
        loadExactSessionEntryCandidatesReadOnlyBatch([
          { ...scope, projection: "list", sessionKeys: [scope.sessionKey] },
        ]);
      try {
        connection
          .prepare("UPDATE session_nodes SET entry_json = ? WHERE session_key = ?")
          .run(
            JSON.stringify({ sessionId: "target", updatedAt: 1, label: "after" }),
            scope.sessionKey,
          );
        expect(read()).toMatchObject([{ ok: true, value: [{ entry: { label: "after" } }] }]);
        listSessionEntriesReadOnly({ ...scope, projection: "list" });
        connection
          .prepare("UPDATE session_participants SET actor_id = ? WHERE session_key = ?")
          .run("after", scope.sessionKey);
        expect(read()).toMatchObject([
          {
            ok: true,
            value: [{ entry: { participants: [{ identity: { type: "profile", id: "after" } }] } }],
          },
        ]);
      } finally {
        if (connection !== database.db) {
          connection.close();
        }
      }
    },
  );

  it("rejects a cache snapshot if an external commit occurs while selected entries are copied", () => {
    const env = { OPENCLAW_STATE_DIR: autoTempDirs.make("openclaw-exact-read-copy-race-") };
    const scope = { agentId: "main", env, sessionKey: "agent:main:target" };
    replaceSessionEntrySync(scope, { sessionId: "target", updatedAt: 1, label: "before" });
    listSessionEntriesReadOnly({ ...scope, projection: "list" });
    const database = openOpenClawAgentDatabase(scope);
    const external = new DatabaseSync(database.path);
    const originalClone = structuredClone;
    const clone = vi.spyOn(globalThis, "structuredClone").mockImplementationOnce((value) => {
      external
        .prepare("UPDATE session_nodes SET entry_json = ? WHERE session_key = ?")
        .run(
          JSON.stringify({ sessionId: "target", updatedAt: 1, label: "after" }),
          scope.sessionKey,
        );
      return originalClone(value);
    });
    try {
      expect(
        loadExactSessionEntryCandidatesReadOnlyBatch([
          { ...scope, projection: "list", sessionKeys: [scope.sessionKey] },
        ]),
      ).toMatchObject([{ ok: true, value: [{ entry: { label: "after" } }] }]);
    } finally {
      clone.mockRestore();
      external.close();
    }
  });

  it.each(["current_session_id", "updated_at", "malformed", "delivery"] as const)(
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
      expect(
        loadExactSessionEntryCandidatesReadOnlyBatch(
          [[healthy], [broken]].map((sessionKeys) => ({
            agentId: scope.agentId,
            env,
            projection: scope.projection,
            sessionKeys,
          })),
        ),
      ).toMatchObject([
        { ok: true, value: [{ sessionKey: healthy }] },
        { ok: false, error: originalError },
      ]);
      expect(
        loadExactSessionEntryCandidatesReadOnlyBatch(
          [[healthy], [broken], ["agent:main:missing"], [healthy, broken]].map((sessionKeys) => ({
            agentId: scope.agentId,
            env,
            projection: scope.projection,
            sessionKeys,
          })),
        ),
      ).toMatchObject([
        { ok: true, value: [{ sessionKey: healthy }] },
        { ok: false, error: originalError },
        { ok: true, value: [] },
        { ok: false, error: originalError },
      ]);
    },
  );

  it.each([false, true])(
    "reads only the target without a listing cache (retained read: %s)",
    (retained) => {
      const env = { OPENCLAW_STATE_DIR: autoTempDirs.make("openclaw-exact-read-uncached-") };
      const scope = { agentId: "main", env, sessionKey: "agent:main:target" };
      replaceSessionEntrySync(scope, { sessionId: "target", updatedAt: 1 });
      replaceSessionEntrySync(
        { ...scope, sessionKey: "agent:main:unrelated" },
        { sessionId: "unrelated", updatedAt: 1, label: "unrelated payload ".repeat(1024) },
      );
      loadExactSessionEntryReadOnly({ ...scope, projection: "list" });
      const database = openOpenClawAgentDatabase(scope);
      const held = retained ? captureSessionEntryRead(database, scope.sessionKey) : undefined;
      const queries = trackSqliteStatementExecutions(database.db, ["entries"], (sql) =>
        /from\s+"session_nodes"/i.test(sql) ? "entries" : null,
      );
      try {
        expect(
          loadExactSessionEntryCandidatesReadOnlyBatch([
            { ...scope, projection: "list", sessionKeys: [scope.sessionKey] },
          ]),
        ).toMatchObject([{ ok: true, value: [{ entry: { sessionId: "target" } }] }]);
        expect(queries.rowCounts.entries).toBe(1);
        expect(queries.textBytes.entries).toBeLessThan(1024);
        if (held) {
          expect(held.isCurrent()).toBe(true);
        }
      } finally {
        queries.restore();
        held?.release();
      }
    },
  );

  it("reads committed entries through the companion while the cached writer has a transaction", () => {
    const env = { OPENCLAW_STATE_DIR: autoTempDirs.make("openclaw-exact-read-committed-") };
    const scope = { agentId: "main", env, sessionKey: "agent:main:target" };
    replaceSessionEntrySync(scope, { sessionId: "target", updatedAt: 1, label: "committed" });
    listSessionEntriesReadOnly({ ...scope, projection: "list" });
    const read = () =>
      loadExactSessionEntryCandidatesReadOnlyBatch([
        { ...scope, projection: "list", sessionKeys: [scope.sessionKey] },
      ]);
    runOpenClawAgentWriteTransaction((database) => {
      database.db
        .prepare("UPDATE session_nodes SET entry_json = ? WHERE session_key = ?")
        .run(
          JSON.stringify({ sessionId: "target", updatedAt: 1, label: "next" }),
          scope.sessionKey,
        );
      expect(read()).toMatchObject([{ ok: true, value: [{ entry: { label: "committed" } }] }]);
    }, scope);
    expect(read()).toMatchObject([{ ok: true, value: [{ entry: { label: "next" } }] }]);
  });

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
      expect(
        loadExactSessionEntryReadOnly({ ...scope, sessionKey: keys[0]!, projection }),
      ).toMatchObject({ entry: expectedEntry });
      listSessionEntriesReadOnly({ ...scope, projection: "list" });
      const result = loadExactSessionEntryCandidatesReadOnlyBatch([
        { agentId: scope.agentId, env, projection, sessionKeys: keys },
      ]);
      expect(result).toMatchObject([
        { ok: true, value: keys.map((sessionKey) => ({ sessionKey, entry: expectedEntry })) },
      ]);
      const selected = result[0];
      if (!selected?.ok) {
        throw new Error("Expected native-equivalent keys to resolve");
      }
      selected.value[0]!.entry.participants![0]!.identity = { type: "profile", id: "mutated" };
      expect(selected.value[1]!.entry.participants).toEqual(expectedEntry.participants);
      expect(selected.value[2]!.entry.participants).toEqual(expectedEntry.participants);
      expect(selected.value[3]!.entry.participants).toEqual([
        { identity: { type: "profile", id: "mutated" } },
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
