import fs from "node:fs";
import path from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { trackSqliteStatementExecutions } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import {
  cleanupTempDirs,
  makeTempDir,
  useAutoCleanupTempDirTracker,
} from "../../../test/helpers/temp-dir.js";
import { clearNodeSqliteKyselyCacheForDatabase } from "../../infra/kysely-sync.js";
import { withOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  closeOpenClawAgentDatabasesForTest,
  getOpenClawAgentDatabaseIfOpen,
  isOpenClawAgentDatabaseOpen,
  openOpenClawAgentDatabase,
  resolveOpenClawAgentSqlitePath,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import {
  hasSessionEntriesByStatusReadOnly,
  listSessionEntriesCore,
  listSessionEntriesReadOnly,
  loadExactSessionEntryCandidatesReadOnlyBatch,
  loadExactSessionEntryReadOnly,
  openSessionEntryReadView,
  readSessionTranscriptWatermark,
  readSessionIdentityEvidenceBatch,
  readSessionStoreSummaryReadOnly,
  replaceSessionEntrySync,
  resolveTranscriptSessionKeyBySessionId,
  upsertSessionEntryCore,
  withSessionEntryReadOnlyScope,
} from "./session-accessor.js";
import { recordSessionParticipant } from "./session-accessor.sqlite-participants.native.js";
import { ensureTranscriptSessionRoot } from "./session-accessor.sqlite-transcript-state.js";
import * as sqliteTargets from "./session-sqlite-target.js";

const tempDirs: string[] = [];
const autoTempDirs = useAutoCleanupTempDirTracker(afterEach);

function countRegisteredAgentDatabases(env: NodeJS.ProcessEnv): number {
  const row = openOpenClawStateDatabase({ env })
    .db.prepare("SELECT count(*) AS count FROM agent_databases")
    .get() as { count: number };
  return row.count;
}

function clearRegisteredAgentDatabases(env: NodeJS.ProcessEnv): void {
  openOpenClawStateDatabase({ env }).db.prepare("DELETE FROM agent_databases").run();
}

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  cleanupTempDirs(tempDirs);
});

describe("session accessor readonly listing", () => {
  it.each([false, true])(
    "closes a shared-store reader and revokes inherited async reuse (throws: %s)",
    async (throws) => {
      const env = { OPENCLAW_STATE_DIR: autoTempDirs.make("openclaw-session-reader-scope-") };
      const storePath = path.join(env.OPENCLAW_STATE_DIR, "shared.sqlite");
      const options = { agentId: "main", env, path: storePath };
      const scope = { agentId: "worker-1", env, storePath, projection: "list" as const };
      const sessionKey = "agent:worker-1:visible";
      openOpenClawAgentDatabase(options);
      replaceSessionEntrySync({ ...scope, sessionKey }, { sessionId: "visible", updatedAt: 1 });
      closeOpenClawAgentDatabasesForTest();
      const captureDatabase = () => {
        const result = withOpenClawAgentDatabaseReadOnly(({ db }) => db, options);
        if (!result.found) {
          throw new Error("Expected existing shared database");
        }
        return result.value;
      };
      const descendants: Promise<DatabaseSync>[] = [];
      let retained: DatabaseSync | undefined;
      const failure = new Error("entry callback failed");
      const run = () =>
        withSessionEntryReadOnlyScope(scope, () => {
          expect(listSessionEntriesReadOnly(scope).map((entry) => entry.sessionKey)).toEqual([
            sessionKey,
          ]);
          retained = captureDatabase();
          expect(retained.isOpen).toBe(true);
          expect(captureDatabase()).toBe(retained);
          descendants.push(Promise.resolve().then(captureDatabase));
          if (throws) {
            throw failure;
          }
          return "complete";
        });
      try {
        if (throws) {
          expect(run).toThrow(failure);
        } else {
          expect(run()).toBe("complete");
        }
        expect(retained?.isOpen).toBe(false);
        const [descendant] = await Promise.all(descendants);
        expect(Object.is(descendant, retained)).toBe(false);
        expect(descendant?.isOpen).toBe(true);
        expect(getOpenClawAgentDatabaseIfOpen(options)).toBeUndefined();
        await closeOpenClawAgentDatabaseByPathAsync(storePath);
        expect(descendant?.isOpen).toBe(false);
      } finally {
        await Promise.allSettled(descendants);
        await closeOpenClawAgentDatabaseByPathAsync(storePath);
      }
    },
  );

  it("reads a committed visibility change through the retained shared-store reader", () => {
    const env = { OPENCLAW_STATE_DIR: autoTempDirs.make("openclaw-session-reader-freshness-") };
    const storePath = path.join(env.OPENCLAW_STATE_DIR, "shared.sqlite");
    const options = { agentId: "main", env, path: storePath };
    const scope = { agentId: "worker-1", env, storePath, projection: "list" as const };
    const sessionKey = "agent:worker-1:visible";
    const entry = { sessionId: "visible", updatedAt: 1, visibility: "shared" as const };
    openOpenClawAgentDatabase(options);
    replaceSessionEntrySync({ ...scope, sessionKey }, entry);
    closeOpenClawAgentDatabasesForTest();

    const peer = new DatabaseSync(storePath);
    try {
      withSessionEntryReadOnlyScope(scope, () => {
        expect(listSessionEntriesReadOnly(scope)[0]?.entry.visibility).toBe("shared");
        const retained = withOpenClawAgentDatabaseReadOnly(({ db }) => db, options);
        if (!retained.found) {
          throw new Error("Expected existing shared database");
        }
        expect(retained.value.isOpen).toBe(true);
        expect(loadExactSessionEntryReadOnly({ ...scope, sessionKey })?.entry.visibility).toBe(
          "shared",
        );
        peer
          .prepare(
            "UPDATE session_nodes SET entry_json = json_set(entry_json, '$.visibility', ?) WHERE session_key = ?",
          )
          .run("draft", sessionKey);
        expect(loadExactSessionEntryReadOnly({ ...scope, sessionKey })?.entry.visibility).toBe(
          "draft",
        );
        expect(listSessionEntriesReadOnly(scope)[0]?.entry.visibility).toBe("draft");
        withOpenClawAgentDatabaseReadOnly(({ db }) => expect(db).toBe(retained.value), options);
      });
    } finally {
      peer.close();
    }
    expect(getOpenClawAgentDatabaseIfOpen(options)).toBeUndefined();
  });

  it("resolves a registered exact store once per batch and observes its next owner", () => {
    const env = { OPENCLAW_STATE_DIR: autoTempDirs.make("openclaw-exact-read-target-") };
    const storePath = path.join(env.OPENCLAW_STATE_DIR, "registered.sqlite");
    const scope = { agentId: "worker-1", env, storePath, projection: "list" as const };
    const keys = [
      "agent:worker-1:first",
      "agent:worker-1:second",
      "agent:worker-1:missing",
    ] as const;
    openOpenClawAgentDatabase({ agentId: scope.agentId, env, path: storePath });
    for (const sessionKey of keys.slice(0, 2)) {
      replaceSessionEntrySync({ ...scope, sessionKey }, { sessionId: sessionKey, updatedAt: 1 });
    }
    const resolve = vi.spyOn(sqliteTargets, "resolveSqliteTargetFromSessionStorePath");
    const read = () =>
      loadExactSessionEntryCandidatesReadOnlyBatch(
        keys.map((sessionKey) => ({ ...scope, sessionKeys: [sessionKey] })),
      );
    try {
      expect(read()).toMatchObject([
        { ok: true, value: [{ sessionKey: keys[0], entry: { sessionId: keys[0] } }] },
        { ok: true, value: [{ sessionKey: keys[1], entry: { sessionId: keys[1] } }] },
        { ok: true, value: [] },
      ]);
      expect(resolve).toHaveBeenCalledOnce();

      closeOpenClawAgentDatabasesForTest();
      clearRegisteredAgentDatabases(env);
      fs.renameSync(storePath, `${storePath}.previous`);
      openOpenClawAgentDatabase({ agentId: "worker-2", env, path: storePath });
      replaceSessionEntrySync(
        { ...scope, sessionKey: keys[0] },
        { sessionId: "replacement-first", updatedAt: 2 },
      );
      resolve.mockClear();
      expect(read()).toMatchObject([
        { ok: true, value: [{ sessionKey: keys[0], entry: { sessionId: "replacement-first" } }] },
        { ok: true, value: [] },
        { ok: true, value: [] },
      ]);
      expect(resolve).toHaveBeenCalledOnce();
    } finally {
      resolve.mockRestore();
    }
  });

  it("returns the same entries as the writable listing for a populated agent database", async () => {
    const stateDir = makeTempDir(tempDirs, "openclaw-session-readonly-populated-");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const listScope = { agentId: "worker-1", env };

    await upsertSessionEntryCore(
      { ...listScope, sessionKey: "agent:worker-1:main" },
      { sessionId: "session-1", updatedAt: 10 },
    );
    await upsertSessionEntryCore(
      { ...listScope, sessionKey: "agent:worker-1:telegram:dm:42" },
      { sessionId: "session-2", updatedAt: 20 },
    );
    const writableEntries = listSessionEntriesCore(listScope);
    const database = expectDefined(getOpenClawAgentDatabaseIfOpen(listScope), "held agent store");
    const handle = database.db;
    const expectedSummary = {
      count: 2,
      recent: writableEntries.toReversed(),
      byAgent: new Map([[listScope.agentId, { count: 2, recent: writableEntries.toReversed() }]]),
    };
    const summaryOptions = { recentLimit: 2, agentIds: [listScope.agentId] };

    expect(readSessionStoreSummaryReadOnly(listScope, summaryOptions)).toEqual(expectedSummary);
    expect(getOpenClawAgentDatabaseIfOpen(listScope)).toBe(database);
    expect(database.db).toBe(handle);
    expect(handle.isOpen).toBe(true);
    expect(handle.isTransaction).toBe(false);
    closeOpenClawAgentDatabasesForTest();

    expect(listSessionEntriesReadOnly(listScope)).toEqual(writableEntries);
    expect(openSessionEntryReadView(listScope).entries()).toEqual(writableEntries);
    expect(readSessionStoreSummaryReadOnly(listScope, summaryOptions)).toEqual(expectedSummary);
    expect(isOpenClawAgentDatabaseOpen(resolveOpenClawAgentSqlitePath(listScope))).toBe(false);
  });

  it("keeps missing database probes read-only with empty exact results", () => {
    const stateDir = makeTempDir(tempDirs, "openclaw-session-readonly-missing-");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const agentId = "worker-1";
    const databasePath = resolveOpenClawAgentSqlitePath({ agentId, env });
    clearRegisteredAgentDatabases(env);

    expect(listSessionEntriesReadOnly({ agentId, env })).toEqual([]);
    expect(openSessionEntryReadView({ agentId, env }).entries()).toEqual([]);
    expect(
      loadExactSessionEntryCandidatesReadOnlyBatch([
        { agentId, env, sessionKeys: [`agent:${agentId}:main`] },
      ]),
    ).toMatchObject([{ ok: true, value: [] }]);
    expect(
      readSessionStoreSummaryReadOnly(
        { agentId, env },
        {
          recentLimit: 10,
          agentIds: [agentId],
        },
      ),
    ).toEqual({
      count: 0,
      recent: [],
      byAgent: new Map([[agentId, { count: 0, recent: [] }]]),
    });
    expect(fs.existsSync(databasePath)).toBe(false);
    expect(countRegisteredAgentDatabases(env)).toBe(0);
  });

  it("summarizes pending rows, hidden keys, retained windows, and ties with listing semantics", () => {
    const env = { OPENCLAW_STATE_DIR: autoTempDirs.make("openclaw-session-summary-rows-") };
    const scope = { agentId: "main", env };
    for (const [key, updatedAt] of [
      ["zero", 0],
      ["tie-b", 20],
      ["tie-a", 20],
      ["pending", 10],
      ["bad-json", 15],
      ["bad-timestamp", 16],
      ["ordinary:internal-session-effects:visible", 5],
      ["internal-session-effects", 4],
      ["internal-session-effects-extra:visible", 3],
      ["internal-session-effects:hidden:extra", 998],
      ["internal-session-effects:hidden", 999],
    ] as const) {
      replaceSessionEntrySync(
        { ...scope, sessionKey: `agent:main:${key}` },
        { sessionId: key, updatedAt },
      );
    }
    for (const sessionKey of ["global", "unknown"]) {
      replaceSessionEntrySync({ ...scope, sessionKey }, { sessionId: sessionKey, updatedAt: 1000 });
    }
    runOpenClawAgentWriteTransaction((database) => {
      ensureTranscriptSessionRoot(
        database,
        { ...scope, sessionKey: "agent:main:retained", sessionId: "retained" },
        2000,
      );
    }, scope);
    listSessionEntriesReadOnly(scope);
    const database = openOpenClawAgentDatabase(scope);
    const update = database.db.prepare(
      "UPDATE session_nodes SET entry_json = ?, updated_at = ? WHERE session_key = ?",
    );
    update.run(
      JSON.stringify({ sessionId: "pending-updated", updatedAt: 30, label: "fresh" }),
      30,
      "agent:main:pending",
    );
    update.run("{", 40, "agent:main:bad-json");
    update.run(
      JSON.stringify({ sessionId: "bad-timestamp", updatedAt: 99 }),
      50,
      "agent:main:bad-timestamp",
    );
    const expectedKeys = [
      "agent:main:pending",
      "agent:main:tie-a",
      "agent:main:tie-b",
      "agent:main:ordinary:internal-session-effects:visible",
      "agent:main:internal-session-effects",
      "agent:main:internal-session-effects-extra:visible",
      "agent:main:zero",
    ];
    const options = { recentLimit: 3, agentIds: [scope.agentId] };

    const listed = listSessionEntriesReadOnly({ ...scope, readConsistency: "latest" });
    expect(
      listed
        .filter(({ sessionKey }) => !["global", "unknown"].includes(sessionKey))
        .map(({ sessionKey }) => sessionKey)
        .toSorted((left, right) => left.localeCompare(right)),
    ).toEqual(expectedKeys.toSorted((left, right) => left.localeCompare(right)));
    const summary = readSessionStoreSummaryReadOnly(scope, options);
    expect(summary.count).toBe(7);
    expect(summary.recent.map(({ sessionKey }) => sessionKey)).toEqual(expectedKeys.slice(0, 3));
    expect(summary.recent[0]?.entry).toMatchObject({
      sessionId: "pending-updated",
      label: "fresh",
    });
    expectDefined(summary.recent[0], "recent pending session").entry.label = "caller-owned";
    expect(readSessionStoreSummaryReadOnly(scope, options).recent[0]?.entry.label).toBe("fresh");
    expect(readSessionStoreSummaryReadOnly(scope, { ...options, recentLimit: 0 })).toEqual({
      count: 7,
      recent: [],
      byAgent: new Map([[scope.agentId, { count: 7, recent: [] }]]),
    });

    const retainedScope = { ...scope, sessionKey: "agent:main:retained" };
    const exactReadFailure = {
      ok: false,
      error: expect.objectContaining({ message: expect.stringContaining("openclaw doctor --fix") }),
    };
    for (const projection of ["full", "list"] as const) {
      expect(loadExactSessionEntryReadOnly({ ...retainedScope, projection })).toBeUndefined();
      for (const key of ["pending", "bad-json", "bad-timestamp"]) {
        expect(() =>
          loadExactSessionEntryReadOnly({ ...scope, sessionKey: `agent:main:${key}`, projection }),
        ).toThrow("openclaw doctor --fix");
      }
      const grouped = loadExactSessionEntryCandidatesReadOnlyBatch(
        [
          ["agent:main:tie-b"],
          ["agent:main:pending"],
          ["agent:main:bad-json"],
          ["agent:main:tie-a", "agent:main:bad-timestamp"],
          ["agent:main:tie-a"],
          [retainedScope.sessionKey, "agent:main:missing"],
        ].map((sessionKeys) => ({
          agentId: scope.agentId,
          env,
          storePath: database.path,
          sessionKeys,
          projection,
        })),
      );
      expect(grouped).toMatchObject([
        {
          ok: true,
          value: [{ sessionKey: "agent:main:tie-b", entry: { sessionId: "tie-b" } }],
        },
        exactReadFailure,
        exactReadFailure,
        exactReadFailure,
        { ok: true, value: [{ sessionKey: "agent:main:tie-a", entry: { sessionId: "tie-a" } }] },
        { ok: true, value: [] },
      ]);
    }
    update.run(
      JSON.stringify({ skillsSnapshot: { prompt: "invalid prompt-only row" } }),
      2000,
      retainedScope.sessionKey,
    );
    expect(() => loadExactSessionEntryReadOnly({ ...retainedScope, projection: "list" })).toThrow(
      "openclaw doctor --fix",
    );

    closeOpenClawAgentDatabasesForTest();
    expect(() => readSessionStoreSummaryReadOnly(scope, options)).toThrow("openclaw doctor --fix");
    expect(
      loadExactSessionEntryCandidatesReadOnlyBatch(
        ["agent:main:pending", "agent:main:tie-a"].map((sessionKey) => ({
          agentId: scope.agentId,
          env,
          sessionKeys: [sessionKey],
        })),
      ),
    ).toEqual([exactReadFailure, exactReadFailure]);
  });

  it("batches shared-store recent payloads and participants without dropping saved entry fields", () => {
    const env = { OPENCLAW_STATE_DIR: autoTempDirs.make("openclaw-session-summary-batch-") };
    const storePath = path.join(env.OPENCLAW_STATE_DIR, "shared.sqlite");
    const database = openOpenClawAgentDatabase({ agentId: "main", env, path: storePath });
    const agentIds = Array.from({ length: 8 }, (_, index) => `worker-${index}`);
    const participant = database.db.prepare(
      "INSERT INTO session_participants (session_key, identity_namespace, actor_id, contribution_count, first_prompted_at, last_prompted_at) VALUES (?, ?, ?, 1, 1, 1)",
    );
    for (const agentId of agentIds) {
      for (let index = 0; index < 6; index += 1) {
        const sessionKey = `agent:${agentId}:session-${index}`;
        replaceSessionEntrySync(
          { agentId, env, storePath, sessionKey },
          {
            sessionId: `${agentId}-${index}`,
            updatedAt: index,
            skillsSnapshot: { prompt: "saved prompt", skills: [] },
          },
        );
        participant.run(sessionKey, '{"type":"profile"}', "alice");
      }
    }
    const scope = { agentId: "main", env, storePath };
    const options = { recentLimit: 5, agentIds };
    readSessionStoreSummaryReadOnly(scope, options);
    const queries = trackSqliteStatementExecutions(
      database.db,
      ["payloads", "participants"],
      (sql) => {
        if (sql.includes('from "session_participants"')) {
          return "participants";
        }
        if (sql.includes('select * from "session_nodes"')) {
          return "payloads";
        }
        return null;
      },
    );
    try {
      const summary = readSessionStoreSummaryReadOnly(scope, options);
      expect(summary.count).toBe(48);
      expect(summary.recent.map(({ sessionKey }) => sessionKey)).toEqual(
        agentIds.slice(0, 5).map((agentId) => `agent:${agentId}:session-5`),
      );
      for (const agentId of agentIds) {
        const agent = expectDefined(summary.byAgent.get(agentId), "shared-store agent");
        expect(agent.count).toBe(6);
        expect(agent.recent.map(({ entry }) => entry.sessionId)).toEqual(
          [5, 4, 3, 2, 1].map((index) => `${agentId}-${index}`),
        );
        for (const { entry } of agent.recent) {
          expect(entry.skillsSnapshot?.prompt).toBe("saved prompt");
          expect(entry.participants).toEqual([{ identity: { type: "profile", id: "alice" } }]);
        }
      }
      expect(queries.counts.payloads).toBeLessThanOrEqual(2);
      expect(queries.counts.participants).toBeLessThanOrEqual(2);
    } finally {
      queries.restore();
    }
  });

  it("fills recent slots after unreadable settled rows and only decodes consumed participants", () => {
    const env = { OPENCLAW_STATE_DIR: autoTempDirs.make("openclaw-session-summary-fallback-") };
    const scope = { agentId: "main", env };
    const keys = Array.from({ length: 8 }, (_, index) => `agent:main:entry-${index}`);
    const participantSessionKey = expectDefined(keys[5], "participant session key");
    for (const [index, sessionKey] of keys.entries()) {
      replaceSessionEntrySync(
        { ...scope, sessionKey },
        { sessionId: `entry-${index}`, updatedAt: 8 - index },
      );
    }
    const options = { recentLimit: 2, agentIds: [scope.agentId] };
    readSessionStoreSummaryReadOnly(scope, options);
    const database = openOpenClawAgentDatabase(scope);
    const invalidate = database.db.prepare(
      "UPDATE session_nodes SET entry_json = '{' WHERE session_key = ?",
    );
    const settle = database.db.prepare(
      "UPDATE session_nodes SET entry_valid = 1 WHERE session_key = ?",
    );
    for (const sessionKey of keys.slice(0, 3)) {
      invalidate.run(sessionKey);
      settle.run(sessionKey);
    }
    database.db
      .prepare(
        "INSERT INTO session_participants (session_key, identity_namespace, actor_id, contribution_count, first_prompted_at, last_prompted_at) VALUES (?, ?, ?, 1, 1, 1)",
      )
      .run(participantSessionKey, "invalid namespace", "alice");
    const summary = readSessionStoreSummaryReadOnly(scope, options);
    expect(summary.count).toBe(5);
    expect(summary.recent.map(({ sessionKey }) => sessionKey)).toEqual(keys.slice(3, 5));
    expect(summary.byAgent.get(scope.agentId)?.recent).toEqual(summary.recent);

    // Pending rows are still parsed outside the recent window, including their participants.
    database.db
      .prepare("UPDATE session_nodes SET entry_valid = 0 WHERE session_key = ?")
      .run(participantSessionKey);
    expect(() => readSessionStoreSummaryReadOnly(scope, options)).toThrow(SyntaxError);
  });

  it("surfaces missing canonical transcript tables through watermark reads", async () => {
    const stateDir = makeTempDir(tempDirs, "openclaw-session-readonly-missing-transcript-table-");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const scope = {
      agentId: "worker-1",
      env,
      sessionId: "session-1",
      sessionKey: "agent:worker-1:main",
    };
    await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
    openOpenClawAgentDatabase({ agentId: scope.agentId, env }).db.exec(
      "DROP TABLE transcript_events;",
    );

    expect(() => readSessionTranscriptWatermark(scope)).toThrow(
      expect.objectContaining({
        name: "SessionMetadataUnavailableError",
        reason: "table-missing",
        missingTables: ["transcript_events"],
      }),
    );
  });

  it("probes lifecycle status without creating or registering a missing database", () => {
    const stateDir = makeTempDir(tempDirs, "openclaw-session-readonly-status-missing-");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const agentId = "worker-1";
    const databasePath = resolveOpenClawAgentSqlitePath({ agentId, env });
    clearRegisteredAgentDatabases(env);

    expect(hasSessionEntriesByStatusReadOnly({ agentId, env }, ["running"])).toBe(false);
    expect(fs.existsSync(databasePath)).toBe(false);
    expect(countRegisteredAgentDatabases(env)).toBe(0);
  });

  it("distinguishes non-session agent state from a running session row", async () => {
    const stateDir = makeTempDir(tempDirs, "openclaw-session-readonly-status-existing-");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const agentId = "worker-1";
    const databasePath = resolveOpenClawAgentSqlitePath({ agentId, env });
    openOpenClawAgentDatabase({ agentId, env, path: databasePath });
    closeOpenClawAgentDatabasesForTest();
    clearRegisteredAgentDatabases(env);

    expect(hasSessionEntriesByStatusReadOnly({ agentId, env }, ["running"])).toBe(false);
    expect(countRegisteredAgentDatabases(env)).toBe(0);

    await upsertSessionEntryCore(
      { agentId, env, sessionKey: "agent:worker-1:main" },
      { sessionId: "session-1", status: "running", updatedAt: 10 },
    );
    closeOpenClawAgentDatabasesForTest();
    clearRegisteredAgentDatabases(env);

    expect(hasSessionEntriesByStatusReadOnly({ agentId, env }, ["running"])).toBe(true);
    expect(hasSessionEntriesByStatusReadOnly({ agentId, env }, ["done"])).toBe(false);
    expect(countRegisteredAgentDatabases(env)).toBe(0);
  });

  it.each(["interrupted", "failed"] as const)(
    "probes canonical %s without conflating its shared derived status",
    async (status) => {
      const env = { OPENCLAW_STATE_DIR: autoTempDirs.make("openclaw-readonly-canonical-status-") };
      const scope = { agentId: "worker-1", env };
      await upsertSessionEntryCore(
        { ...scope, sessionKey: "agent:worker-1:main" },
        { sessionId: "session-1", status, updatedAt: 10 },
      );
      closeOpenClawAgentDatabasesForTest();
      clearRegisteredAgentDatabases(env);

      expect(hasSessionEntriesByStatusReadOnly(scope, [status])).toBe(true);
      expect(
        hasSessionEntriesByStatusReadOnly(scope, [
          status === "interrupted" ? "failed" : "interrupted",
        ]),
      ).toBe(false);
      expect(hasSessionEntriesByStatusReadOnly(scope, ["interrupted", "failed"])).toBe(true);
      expect(hasSessionEntriesByStatusReadOnly(scope, ["running", "done"])).toBe(false);
      expect(hasSessionEntriesByStatusReadOnly(scope, [])).toBe(false);
      expect(countRegisteredAgentDatabases(env)).toBe(0);
      expect(isOpenClawAgentDatabaseOpen(resolveOpenClawAgentSqlitePath(scope))).toBe(false);
    },
  );

  it("resolves a missing session identity without creating or registering a database", () => {
    const stateDir = makeTempDir(tempDirs, "openclaw-session-readonly-missing-identity-");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const agentId = "worker-1";
    const databasePath = resolveOpenClawAgentSqlitePath({ agentId, env });
    clearRegisteredAgentDatabases(env);

    expect(
      resolveTranscriptSessionKeyBySessionId({ agentId, env, sessionId: "missing-session" }),
    ).toBeUndefined();
    expect(fs.existsSync(databasePath)).toBe(false);
    expect(countRegisteredAgentDatabases(env)).toBe(0);
  });

  it("resolves an existing session identity without registering its database", async () => {
    const stateDir = makeTempDir(tempDirs, "openclaw-session-readonly-existing-identity-");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const agentId = "worker-1";
    const sessionKey = "agent:worker-1:main";
    await upsertSessionEntryCore(
      { agentId, env, sessionKey },
      { sessionId: "session-1", updatedAt: 1 },
    );
    closeOpenClawAgentDatabasesForTest();
    clearRegisteredAgentDatabases(env);

    expect(resolveTranscriptSessionKeyBySessionId({ agentId, env, sessionId: "session-1" })).toBe(
      sessionKey,
    );
    expect(countRegisteredAgentDatabases(env)).toBe(0);
  });

  it("batches exact, moved, absent, and unreadable session identity evidence", async () => {
    const stateDir = autoTempDirs.make("openclaw-session-readonly-evidence-");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const agentId = "worker-1";
    const sessionKey = "agent:worker-1:moved";
    const sessionId = "session-1";
    await upsertSessionEntryCore({ agentId, env, sessionKey }, { sessionId, updatedAt: 1 });
    const storePath = resolveOpenClawAgentSqlitePath({ agentId, env });
    const invalidSessionKey = "agent:worker-1:invalid";
    await upsertSessionEntryCore(
      { agentId, env, sessionKey: invalidSessionKey },
      { sessionId: "invalid-session", updatedAt: 1 },
    );
    openOpenClawAgentDatabase({ agentId, env })
      .db.prepare("UPDATE session_nodes SET entry_valid = 0 WHERE session_key = ?")
      .run(invalidSessionKey);
    const migrationInvalidAgentId = "migration-invalid";
    const migrationInvalidSessionKey = "agent:migration-invalid:main";
    await upsertSessionEntryCore(
      { agentId: migrationInvalidAgentId, env, sessionKey: migrationInvalidSessionKey },
      { sessionId: "migration-invalid-session", updatedAt: 1 },
    );
    const invalidDatabase = openOpenClawAgentDatabase({ agentId: migrationInvalidAgentId, env });
    invalidDatabase.db.exec("PRAGMA user_version = 999;");
    const invalidStorePath = invalidDatabase.path;
    const missingAgentId = "missing";
    const missingStorePath = resolveOpenClawAgentSqlitePath({ agentId: missingAgentId, env });
    const unreadableAgentId = "unreadable";
    const unreadableStorePath = resolveOpenClawAgentSqlitePath({
      agentId: unreadableAgentId,
      env,
    });
    fs.mkdirSync(unreadableStorePath, { recursive: true });

    expect(
      readSessionIdentityEvidenceBatch([
        { agentId, sessionId, sessionKey, storePath },
        {
          agentId,
          sessionId,
          sessionKey: "agent:worker-1:old-key",
          storePath,
        },
        { agentId, sessionId: "missing-session", sessionKey, storePath },
        {
          agentId,
          sessionId: "invalid-session",
          sessionKey: invalidSessionKey,
          storePath,
        },
        {
          agentId: missingAgentId,
          sessionId: "missing-session",
          sessionKey: "agent:missing:main",
          storePath: missingStorePath,
        },
        {
          agentId: migrationInvalidAgentId,
          sessionId: "migration-invalid-session",
          sessionKey: migrationInvalidSessionKey,
          storePath: invalidStorePath,
        },
        {
          agentId: unreadableAgentId,
          sessionId: "unreadable-session",
          sessionKey: "agent:unreadable:main",
          storePath: unreadableStorePath,
        },
      ]),
    ).toEqual([
      { status: "current", sessionKey },
      { status: "current", sessionKey },
      { status: "absent" },
      { status: "unknown", reason: "row-invalid" },
      { status: "absent" },
      { status: "unknown", reason: "read-failed" },
      { status: "unknown", reason: "read-failed" },
    ]);
  });

  it("does not prefer a main key when only a shared physical session identity is known", async () => {
    const stateDir = autoTempDirs.make("openclaw-session-readonly-shared-identity-");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const agentId = "worker-1";
    const sessionId = "shared-generation";
    const mainKey = "agent:worker-1:main";
    const otherKey = "agent:worker-1:other";
    for (const sessionKey of [mainKey, otherKey]) {
      await upsertSessionEntryCore({ agentId, env, sessionKey }, { sessionId, updatedAt: 1 });
    }
    const storePath = resolveOpenClawAgentSqlitePath({ agentId, env });
    const probe = { agentId, env, sessionId, storePath };

    expect(
      readSessionIdentityEvidenceBatch([
        probe,
        { ...probe, sessionKey: mainKey },
        { ...probe, sessionKey: otherKey },
      ]),
    ).toEqual([
      { status: "unknown", reason: "ambiguous" },
      { status: "current", sessionKey: mainKey },
      { status: "current", sessionKey: otherKey },
    ]);
  });

  it.each(["identity", "timestamp", "json", "nul", "participant", "participant-integer"])(
    "rejects stale valid %s evidence without relying on a fallback read",
    async (corruption) => {
      const stateDir = autoTempDirs.make("openclaw-session-readonly-stale-valid-evidence-");
      const env = { OPENCLAW_STATE_DIR: stateDir };
      const agentId = "worker-1";
      const sessionId = "session-1";
      const sessionKey = "agent:worker-1:main";
      await upsertSessionEntryCore({ agentId, env, sessionKey }, { sessionId, updatedAt: 1 });
      const readableSessionId = "session-2";
      const readableSessionKey = "agent:worker-1:readable";
      await upsertSessionEntryCore(
        { agentId, env, sessionKey: readableSessionKey },
        { sessionId: readableSessionId, updatedAt: 1 },
      );
      const database = openOpenClawAgentDatabase({ agentId, env });
      if (corruption === "participant" || corruption === "participant-integer") {
        recordSessionParticipant(
          { agentId, env, sessionKey },
          { identity: { type: "agent", id: "peer" }, promptedAt: 1 },
        );
        if (corruption === "participant") {
          database.db
            .prepare("UPDATE session_participants SET identity_namespace = ? WHERE session_key = ?")
            .run("{}", sessionKey);
        } else {
          database.db
            .prepare("UPDATE session_participants SET contribution_count = ? WHERE session_key = ?")
            .run(9007199254740992n, sessionKey);
        }
      } else {
        const entryJson =
          corruption === "json"
            ? "{"
            : JSON.stringify({
                sessionId: corruption === "identity" ? "mismatched-session" : sessionId,
                updatedAt: corruption === "timestamp" ? 2 : 1,
              });
        database.db
          .prepare("UPDATE session_nodes SET entry_json = ? WHERE session_key = ?")
          .run(corruption === "nul" ? entryJson + "\0" : entryJson, sessionKey);
      }
      database.db
        .prepare("UPDATE session_nodes SET entry_valid = 1 WHERE session_key = ?")
        .run(sessionKey);

      expect(
        readSessionIdentityEvidenceBatch([
          { agentId, env, sessionId, sessionKey, storePath: database.path },
        ]),
      ).toEqual([{ status: "unknown", reason: "row-invalid" }]);

      expect(
        readSessionIdentityEvidenceBatch([
          { agentId, sessionId, sessionKey, storePath: database.path },
          {
            agentId,
            sessionId,
            sessionKey: "agent:worker-1:old-key",
            storePath: database.path,
          },
          {
            agentId,
            sessionId: readableSessionId,
            sessionKey: readableSessionKey,
            storePath: database.path,
          },
        ]),
      ).toEqual([
        { status: "unknown", reason: "row-invalid" },
        { status: "unknown", reason: "row-invalid" },
        { status: "current", sessionKey: readableSessionKey },
      ]);
    },
  );

  it("keeps retained identity ambiguity even when the exact key is present", async () => {
    const env = { OPENCLAW_STATE_DIR: autoTempDirs.make("openclaw-session-retained-evidence-") };
    const scope = { agentId: "worker-1", env };
    const sessionId = "retained-generation";
    const sessionKey = "agent:worker-1:retained";
    runOpenClawAgentWriteTransaction((database) => {
      ensureTranscriptSessionRoot(database, { ...scope, sessionKey, sessionId }, 1);
    }, scope);
    const storePath = resolveOpenClawAgentSqlitePath(scope);
    const probe = { ...scope, sessionId, sessionKey, storePath };
    expect(readSessionIdentityEvidenceBatch([probe])).toEqual([{ status: "absent" }]);

    const currentKey = "agent:worker-1:current";
    await upsertSessionEntryCore({ ...scope, sessionKey: currentKey }, { sessionId, updatedAt: 1 });

    expect(
      readSessionIdentityEvidenceBatch([
        probe,
        { ...probe, sessionKey: currentKey },
        { ...scope, sessionId, storePath },
      ]),
    ).toEqual([
      { status: "unknown", reason: "ambiguous" },
      { status: "current", sessionKey: currentKey },
      { status: "unknown", reason: "ambiguous" },
    ]);
  });

  it("validates a later required fallback row after another connection commits", async () => {
    const stateDir = autoTempDirs.make("openclaw-session-evidence-external-commit-");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const agentId = "worker-1";
    const sessionKey = "agent:worker-1:main";
    const sessionId = "shared-generation";
    await upsertSessionEntryCore({ agentId, env, sessionKey }, { sessionId, updatedAt: 1 });
    const database = openOpenClawAgentDatabase({ agentId, env });
    const probe = { agentId, env, sessionId, storePath: database.path };
    const probes = [{ ...probe, sessionKey }, probe];
    expect(readSessionIdentityEvidenceBatch(probes)).toEqual([
      { status: "current", sessionKey },
      { status: "current", sessionKey },
    ]);

    const external = new DatabaseSync(database.path);
    const events: string[] = [];
    clearNodeSqliteKyselyCacheForDatabase(database.db);
    const originalPrepare = database.db.prepare.bind(database.db);
    const prepareSpy = vi.spyOn(database.db, "prepare").mockImplementation((sqlText) => {
      const statement = originalPrepare(sqlText);
      const normalized = sqlText.toLowerCase().replaceAll(/\s+/g, " ");
      if (!normalized.includes('from "session_nodes"')) {
        return statement;
      }
      const exact = normalized.includes('where "session_key" in');
      const fallback = normalized.includes('where "current_session_id" in');
      if (!exact && !fallback) {
        return statement;
      }
      const afterRead = () => {
        events.push(exact ? "exact-read" : "fallback-read");
        if (exact) {
          // Commit after SQLite finishes the exact read. The identity-only probe
          // still requires a fallback, whose later row must replace that snapshot.
          external.exec("BEGIN IMMEDIATE");
          try {
            external
              .prepare(
                "UPDATE session_nodes SET entry_json = ?, updated_at = ? WHERE session_key = ?",
              )
              .run(JSON.stringify({ sessionId, updatedAt: 2 }), 3, sessionKey);
            external
              .prepare("UPDATE session_nodes SET entry_valid = 1 WHERE session_key = ?")
              .run(sessionKey);
            external.exec("COMMIT");
            events.push("external-commit");
          } catch (error) {
            external.exec("ROLLBACK");
            throw error;
          }
        }
      };
      const originalAll = statement.all.bind(statement);
      statement.all = new Proxy(originalAll, {
        apply(all, _receiver, args) {
          const rows = all(...args);
          afterRead();
          return rows;
        },
      });
      const originalIterate = statement.iterate.bind(statement) as (
        ...args: unknown[]
      ) => ReturnType<StatementSync["iterate"]>;
      statement.iterate = ((...args: unknown[]) => {
        const rows = originalIterate(...args);
        return (function* () {
          yield* rows;
          afterRead();
        })();
      }) as StatementSync["iterate"];
      return statement;
    });
    try {
      const observed = readSessionIdentityEvidenceBatch(probes);
      expect(events).toEqual(["exact-read", "external-commit", "fallback-read"]);
      expect(observed).toEqual([
        { status: "unknown", reason: "row-invalid" },
        { status: "unknown", reason: "row-invalid" },
      ]);
    } finally {
      clearNodeSqliteKyselyCacheForDatabase(database.db);
      prepareSpy.mockRestore();
      external.close();
    }
  });

  it("uses the current-session-id index for fallback identity probes", async () => {
    const stateDir = autoTempDirs.make("openclaw-session-readonly-evidence-index-");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const agentId = "worker-1";
    const database = openOpenClawAgentDatabase({ agentId, env });
    const detail = database.db
      .prepare(
        "EXPLAIN QUERY PLAN SELECT session_key FROM session_nodes WHERE current_session_id IN (?)",
      )
      .all("session-1")
      .map((row) => {
        const rowDetail = (row as { detail?: unknown }).detail;
        return typeof rowDetail === "string" ? rowDetail : "";
      })
      .join(" ");

    expect(detail).toContain("idx_agent_session_nodes_current_session_id");
  });

  it("does not register a populated database during readonly health-style listing", async () => {
    const stateDir = makeTempDir(tempDirs, "openclaw-session-readonly-registry-");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const agentId = "worker-1";
    const scope = { agentId, env };

    await upsertSessionEntryCore(
      { ...scope, sessionKey: "agent:worker-1:main" },
      { sessionId: "session-1", updatedAt: 10 },
    );
    const databasePath = resolveOpenClawAgentSqlitePath({ agentId, env });
    closeOpenClawAgentDatabasesForTest();
    clearRegisteredAgentDatabases(env);

    expect(listSessionEntriesReadOnly(scope)).toHaveLength(1);
    expect(countRegisteredAgentDatabases(env)).toBe(0);
    expect(isOpenClawAgentDatabaseOpen(databasePath)).toBe(false);
  });
});
