import fs from "node:fs";
import path from "node:path";
import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { clearNodeSqliteKyselyCacheForDatabase } from "../../infra/kysely-sync.js";
import { openNodeSqliteDatabase } from "../../infra/node-sqlite.js";
import type { SqlConnection } from "../../infra/sql-connection.js";
import { revokeSqliteDatabaseAdmissionsForPath } from "../../infra/sqlite-database-admission.js";
import { runSqliteImmediateTransactionSync } from "../../infra/sqlite-transaction.js";
import { withOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
  getOpenClawAgentDatabaseIfOpen,
  isOpenClawAgentDatabaseOpen,
  openOpenClawAgentDatabase,
  resolveOpenClawAgentSqlitePath,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { closeStateDatabaseForTest } from "../../test-utils/database-cleanup.js";
import { requireNativeSqliteDatabase } from "../../test-utils/native-sqlite.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../runtime-snapshot.js";
import {
  listSessionEntriesCore as listEntries,
  listSessionEntriesReadOnly as listReadOnly,
  loadExactSessionEntry as readExactWritable,
  loadExactSessionEntryReadOnly as readExact,
  loadSessionEntry,
  readSessionTranscriptWatermark,
  readSessionIdentityEvidenceBatch as readEvidence,
  replaceSessionEntrySync as writeEntry,
  resolveTranscriptSessionKeyBySessionId as resolveIdentity,
  upsertSessionEntryCore as upsertEntry,
  withSessionEntryReadOnlyScope,
} from "./session-accessor.js";
import { recordSessionParticipant } from "./session-accessor.sqlite-participants.native.js";
import { readSessionStoreSummaryReadOnly as readSummary } from "./session-accessor.sqlite-summary.js";
import { ensureTranscriptSessionRoot } from "./session-accessor.sqlite-transcript-state.js";
import { promptReport } from "./system-prompt-report.test-support.js";

const tempDirs = createTempDirTracker();
const absent = { status: "absent" };
const rowInvalid = { status: "unknown", reason: "row-invalid" };
const ambiguous = { status: "unknown", reason: "ambiguous" };
const readFailed = { status: "unknown", reason: "read-failed" };
const current = (sessionKey: string) => ({ status: "current", sessionKey });

function updateNode(
  db: Pick<SqlConnection, "prepare">,
  sessionKey: string,
  columns: string,
  ...values: SQLInputValue[]
) {
  db.prepare(`UPDATE session_nodes SET ${columns} WHERE session_key = ?`).run(
    ...values,
    sessionKey,
  );
}

function insertParticipant(db: Pick<SqlConnection, "prepare">, key: string, namespace: string) {
  db.prepare(
    "INSERT INTO session_participants (session_key, identity_namespace, actor_id, contribution_count, first_prompted_at, last_prompted_at) VALUES (?, ?, 'alice', 1, 1, 1)",
  ).run(key, namespace);
}

function makeScope(name: string, agentId = "worker-1") {
  const env = { OPENCLAW_STATE_DIR: tempDirs.make(`openclaw-session-${name}-`) };
  return { agentId, env };
}

async function seedIdentity(name: string, sessionId = "session-1", key = "main") {
  const scope = makeScope(name);
  const sessionKey = `agent:worker-1:${key}`;
  await upsertEntry({ ...scope, sessionKey }, { sessionId, updatedAt: 1 });
  const database = openOpenClawAgentDatabase(scope);
  const probe = { ...scope, sessionId, sessionKey, storePath: database.path };
  return { scope, database, probe, sessionId, sessionKey };
}

function makeSharedReader() {
  const { env } = makeScope("shared-reader");
  const storePath = path.join(env.OPENCLAW_STATE_DIR, "shared.sqlite");
  const options = { agentId: "main", env, path: storePath };
  const scope = { agentId: "worker-1", env, storePath, projection: "list" as const };
  const sessionKey = "agent:worker-1:visible";
  openOpenClawAgentDatabase(options);
  writeEntry(
    { ...scope, sessionKey },
    { sessionId: "visible", updatedAt: 1, visibility: "shared" },
  );
  closeOpenClawAgentDatabasesForTest();
  const captureDatabase = () => {
    const result = withOpenClawAgentDatabaseReadOnly(({ db }) => db, options);
    if (!result.found) {
      throw new Error("Expected existing shared database");
    }
    return requireNativeSqliteDatabase(result.value);
  };
  return { options, scope, storePath, sessionKey, captureDatabase };
}

function countRegisteredAgentDatabases(env: NodeJS.ProcessEnv): number {
  const row = openOpenClawStateDatabase({ env })
    .db.prepare("SELECT count(*) AS count FROM agent_databases")
    .get() as { count: number };
  return row.count;
}

function clearRegisteredAgentDatabases(env: NodeJS.ProcessEnv): void {
  openOpenClawStateDatabase({ env }).db.prepare("DELETE FROM agent_databases").run();
}

beforeEach(() => {
  setRuntimeConfigSnapshot({});
});

afterEach(async () => {
  await closeOpenClawAgentDatabasesAsync();
  closeOpenClawAgentDatabasesForTest();
  await closeStateDatabaseForTest();
  tempDirs.cleanup();
  vi.useRealTimers();
  clearRuntimeConfigSnapshot();
});

describe("session accessor readonly listing", () => {
  it("reads borrowed exact-key entries without alias resolution and lists their projections", async () => {
    const mixedKey = "agent:main:matrix:channel:!RoomAbC:example.org";
    const skillsSnapshot = { prompt: "saved skill prompt", skills: [] };
    const scope = {
      agentId: "main",
      env: { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-session-exact-projection-") },
      clone: false,
    };
    await upsertEntry(
      { ...scope, sessionKey: mixedKey },
      { sessionId: "mixed-session", updatedAt: 10, skillsSnapshot },
    );
    const entry = readExact({ ...scope, sessionKey: mixedKey })?.entry;
    const aliasedScope = { ...scope, sessionKey: mixedKey.replace("agent:main", "AGENT:MAIN") };

    expect(entry?.sessionId).toBe("mixed-session");
    expect(entry?.skillsSnapshot).toEqual(skillsSnapshot);
    expect(loadSessionEntry(aliasedScope)).toEqual(entry);
    expect(readExactWritable(aliasedScope)).toBeUndefined();
    expect(readExactWritable({ ...scope, sessionKey: mixedKey })).toEqual({
      sessionKey: mixedKey,
      entry,
    });
    // Exact reads never resolve folded aliases or canonical-key alternatives.
    expect(readExact({ ...scope, sessionKey: mixedKey.toLowerCase() })).toBeUndefined();
    expect(listEntries(scope)).toEqual([
      { sessionKey: mixedKey, entry: expect.objectContaining({ sessionId: "mixed-session" }) },
    ]);
    const metadata = { ...scope, projection: "list" as const };
    const metadataEntry = readExact({ ...metadata, sessionKey: mixedKey })?.entry;
    expect(metadataEntry).toMatchObject({ sessionId: "mixed-session" });
    expect(metadataEntry?.skillsSnapshot).toBeUndefined();
    expect(listEntries(metadata)).toEqual([{ sessionKey: mixedKey, entry: metadataEntry }]);
  });

  it.each([false, true])(
    "closes a shared-store reader and revokes inherited async reuse (throws: %s)",
    async (throws) => {
      const { options, scope, storePath, sessionKey, captureDatabase } = makeSharedReader();
      const descendants: Promise<DatabaseSync>[] = [];
      let retained: DatabaseSync | undefined;
      const failure = new Error("entry callback failed");
      const run = () =>
        withSessionEntryReadOnlyScope(scope, () => {
          expect(listReadOnly(scope).map((entry) => entry.sessionKey)).toEqual([sessionKey]);
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
    vi.useFakeTimers({ toFake: ["setImmediate"] });
    const { options, scope, storePath, sessionKey, captureDatabase } = makeSharedReader();
    const peer = openNodeSqliteDatabase(storePath);
    try {
      withSessionEntryReadOnlyScope(scope, () => {
        expect(listReadOnly(scope)[0]?.entry.visibility).toBe("shared");
        const retained = captureDatabase();
        expect(retained.isOpen).toBe(true);
        expect(readExact({ ...scope, sessionKey })?.entry.visibility).toBe("shared");
        peer
          .prepare(
            "UPDATE session_nodes SET entry_json = json_set(entry_json, '$.visibility', ?) WHERE session_key = ?",
          )
          .run("draft", sessionKey);
        expect(readExact({ ...scope, sessionKey })?.entry.visibility).toBe("draft");
        vi.runOnlyPendingTimers();
        expect(listReadOnly(scope)[0]?.entry.visibility).toBe("draft");
        expect(captureDatabase()).toBe(retained);
      });
    } finally {
      peer.close();
    }
    expect(getOpenClawAgentDatabaseIfOpen(options)).toBeUndefined();
  });

  it("returns the same entries as the writable listing for a populated agent database", async () => {
    const listScope = makeScope("readonly-populated");
    const { env } = listScope;

    await upsertEntry(
      { ...listScope, sessionKey: "agent:worker-1:main" },
      { sessionId: "session-1", updatedAt: 10 },
    );
    await upsertEntry(
      { ...listScope, sessionKey: "agent:worker-1:telegram:dm:42" },
      { sessionId: "session-2", updatedAt: 20 },
    );
    const writableEntries = listEntries(listScope);
    const database = expectDefined(getOpenClawAgentDatabaseIfOpen(listScope), "held agent store");
    const handle = database.db;
    const expectedSummary = {
      count: 2,
      recent: writableEntries.toReversed(),
      byAgent: new Map([[listScope.agentId, { count: 2, recent: writableEntries.toReversed() }]]),
    };
    const summaryOptions = { recentLimit: 2, agentIds: [listScope.agentId] };

    expect(readSummary(listScope, summaryOptions)).toEqual(expectedSummary);
    expect(getOpenClawAgentDatabaseIfOpen(listScope)).toBe(database);
    expect(database.db).toBe(handle);
    expect(handle.isOpen).toBe(true);
    expect(handle.isTransaction).toBe(false);
    await closeOpenClawAgentDatabasesAsync();
    closeOpenClawAgentDatabasesForTest();
    clearRegisteredAgentDatabases(env);

    expect(listReadOnly(listScope)).toEqual(writableEntries);
    expect(listEntries({ ...listScope, clone: false })).toEqual(writableEntries);
    expect(readSummary(listScope, summaryOptions)).toEqual(expectedSummary);
    expect(resolveIdentity({ ...listScope, sessionId: "session-1" })).toBe("agent:worker-1:main");
    expect(isOpenClawAgentDatabaseOpen(resolveOpenClawAgentSqlitePath(listScope))).toBe(false);
    expect(countRegisteredAgentDatabases(env)).toBe(0);
  });

  it("keeps missing database probes read-only with empty exact results", () => {
    const scope = makeScope("readonly-missing");
    const { agentId, env } = scope;
    const databasePath = resolveOpenClawAgentSqlitePath(scope);
    clearRegisteredAgentDatabases(env);

    expect(listReadOnly(scope)).toEqual([]);
    expect(listEntries({ ...scope, clone: false })).toEqual([]);
    expect(readExact({ agentId, env, sessionKey: `agent:${agentId}:main` })).toBeUndefined();
    expect(resolveIdentity({ agentId, env, sessionId: "missing-session" })).toBeUndefined();
    expect(readSummary(scope, { recentLimit: 10, agentIds: [agentId] })).toEqual({
      count: 0,
      recent: [],
      byAgent: new Map([[agentId, { count: 0, recent: [] }]]),
    });
    expect(fs.existsSync(databasePath)).toBe(false);
    expect(countRegisteredAgentDatabases(env)).toBe(0);
  });

  it("summarizes pending rows, hidden keys, retained windows, and ties with listing semantics", () => {
    const scope = makeScope("summary-rows", "main");
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
      writeEntry({ ...scope, sessionKey: `agent:main:${key}` }, { sessionId: key, updatedAt });
    }
    for (const sessionKey of ["global", "unknown"]) {
      writeEntry({ ...scope, sessionKey }, { sessionId: sessionKey, updatedAt: 1000 });
    }
    runOpenClawAgentWriteTransaction((database) => {
      ensureTranscriptSessionRoot(
        database,
        { ...scope, sessionKey: "agent:main:retained", sessionId: "retained" },
        2000,
      );
    }, scope);
    listReadOnly(scope);
    const database = openOpenClawAgentDatabase(scope);
    const update = (key: string, timestamp: number, json: string) =>
      updateNode(
        database.db,
        `agent:main:${key}`,
        "entry_json = ?, updated_at = ?, current_session_id = ?, entry_valid = 0",
        json,
        timestamp,
        key,
      );
    update("pending", 30, JSON.stringify({ sessionId: "pending", updatedAt: 30, label: "fresh" }));
    update("bad-json", 40, "{");
    update("bad-timestamp", 50, JSON.stringify({ sessionId: "bad-timestamp", updatedAt: 99 }));
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

    const listed = listReadOnly({ ...scope, readConsistency: "latest" });
    expect(
      listed
        .filter(({ sessionKey }) => !["global", "unknown"].includes(sessionKey))
        .map(({ sessionKey }) => sessionKey)
        .toSorted((left, right) => left.localeCompare(right)),
    ).toEqual(expectedKeys.toSorted((left, right) => left.localeCompare(right)));
    const summary = readSummary(scope, options);
    expect(summary.count).toBe(7);
    expect(summary.recent.map(({ sessionKey }) => sessionKey)).toEqual(expectedKeys.slice(0, 3));
    expect(summary.recent[0]?.entry).toMatchObject({ sessionId: "pending", label: "fresh" });
    expectDefined(summary.recent[0], "recent pending session").entry.label = "caller-owned";
    expect(readSummary(scope, options).recent[0]?.entry.label).toBe("fresh");
    expect(readSummary(scope, { ...options, recentLimit: 0 })).toEqual({
      count: 7,
      recent: [],
      byAgent: new Map([[scope.agentId, { count: 7, recent: [] }]]),
    });

    const retainedScope = { ...scope, sessionKey: "agent:main:retained" };
    for (const projection of ["full", "list"] as const) {
      expect(readExact({ ...retainedScope, projection })).toBeUndefined();
      expect(
        readExact({ ...scope, sessionKey: "agent:main:pending", projection })?.entry,
      ).toMatchObject({ sessionId: "pending", updatedAt: 30, label: "fresh" });
      for (const key of ["bad-json", "bad-timestamp"]) {
        expect(() => readExact({ ...scope, sessionKey: `agent:main:${key}`, projection })).toThrow(
          "openclaw doctor --fix",
        );
      }
    }
    update(
      "retained",
      2000,
      JSON.stringify({ skillsSnapshot: { prompt: "invalid prompt-only row" } }),
    );
    expect(() => readExact({ ...retainedScope, projection: "list" })).toThrow(
      "openclaw doctor --fix",
    );

    closeOpenClawAgentDatabasesForTest();
    revokeSqliteDatabaseAdmissionsForPath(database.path);
    expect(() => readSummary(scope, options)).toThrow("openclaw doctor --fix");
  });

  it("reads shared-store recent payloads and participants without dropping saved entry fields", () => {
    const env = { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-session-summary-batch-") };
    const storePath = path.join(env.OPENCLAW_STATE_DIR, "shared.sqlite");
    const database = openOpenClawAgentDatabase({ agentId: "main", env, path: storePath });
    const agentIds = Array.from({ length: 8 }, (_, index) => `worker-${index}`);
    for (const agentId of agentIds) {
      for (let index = 0; index < 6; index += 1) {
        const sessionKey = `agent:${agentId}:session-${index}`;
        const sessionId = `${agentId}-${index}`;
        writeEntry(
          { agentId, env, storePath, sessionKey },
          {
            sessionId,
            updatedAt: index,
            sessionDiffBaseline: { version: 1, sessionId, root: "/synthetic", files: [] },
            skillsSnapshot: { prompt: "saved prompt", skills: [] },
            systemPromptReport: { ...promptReport(1, 12, 12), sessionId },
          },
        );
        insertParticipant(database.db, sessionKey, '{"type":"profile"}');
      }
    }
    const scope = { agentId: "main", env, storePath };
    const options = { recentLimit: 5, agentIds };
    const summary = readSummary(scope, options);
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
        expect(entry.sessionDiffBaseline).toEqual({
          version: 1,
          sessionId: entry.sessionId,
          root: "/synthetic",
          files: [],
        });
        expect(entry.skillsSnapshot?.prompt).toBe("saved prompt");
        expect(entry.systemPromptReport?.sessionId).toBe(entry.sessionId);
        expect(entry.participants).toEqual([{ identity: { type: "profile", id: "alice" } }]);
      }
    }
  });

  it("fills recent slots after unreadable settled rows and only decodes consumed participants", () => {
    const scope = makeScope("summary-fallback", "main");
    const keys = Array.from({ length: 8 }, (_, index) => `agent:main:entry-${index}`);
    const participantSessionKey = expectDefined(keys[5], "participant session key");
    for (const [index, sessionKey] of keys.entries()) {
      writeEntry({ ...scope, sessionKey }, { sessionId: `entry-${index}`, updatedAt: 8 - index });
    }
    const options = { recentLimit: 2, agentIds: [scope.agentId] };
    readSummary(scope, options);
    const database = openOpenClawAgentDatabase(scope);
    for (const sessionKey of keys.slice(0, 3)) {
      updateNode(database.db, sessionKey, "entry_json = '{'");
      updateNode(database.db, sessionKey, "entry_valid = 1");
    }
    insertParticipant(database.db, participantSessionKey, "invalid namespace");
    const summary = readSummary(scope, options);
    expect(summary.count).toBe(5);
    expect(summary.recent.map(({ sessionKey }) => sessionKey)).toEqual(keys.slice(3, 5));
    expect(summary.byAgent.get(scope.agentId)?.recent).toEqual(summary.recent);

    // Pending rows are still parsed outside the recent window, including their participants.
    updateNode(database.db, participantSessionKey, "entry_valid = 0");
    expect(() => readSummary(scope, options)).toThrow(SyntaxError);
  });

  it("surfaces missing canonical transcript tables through watermark reads", async () => {
    const { probe: scope, database } = await seedIdentity("readonly-missing-transcript-table");
    database.db.exec("DROP TABLE transcript_events;");

    expect(() => readSessionTranscriptWatermark(scope)).toThrow(
      expect.objectContaining({
        name: "SessionMetadataUnavailableError",
        reason: "table-missing",
        missingTables: ["transcript_events"],
      }),
    );
  });

  it("batches exact, moved, absent, and unreadable session identity evidence", async () => {
    const { scope, database, probe, sessionKey } = await seedIdentity(
      "readonly-evidence",
      "session-1",
      "moved",
    );
    const { env } = scope;
    const invalidSessionKey = "agent:worker-1:invalid";
    await upsertEntry(
      { ...scope, sessionKey: invalidSessionKey },
      { sessionId: "invalid-session", updatedAt: 1 },
    );
    expect(
      readEvidence([
        probe,
        { ...probe, sessionId: "invalid-session", sessionKey: invalidSessionKey },
      ]),
    ).toEqual([current(sessionKey), current(invalidSessionKey)]);
    updateNode(database.db, invalidSessionKey, "entry_valid = 0");
    const migration = {
      agentId: "migration-invalid",
      env,
      sessionKey: "agent:migration-invalid:main",
    };
    await upsertEntry(migration, { sessionId: "migration-invalid-session", updatedAt: 1 });
    const invalidDatabase = openOpenClawAgentDatabase(migration);
    invalidDatabase.db.exec("PRAGMA user_version = 999;");
    const invalidStorePath = invalidDatabase.path;
    await closeOpenClawAgentDatabaseByPathAsync(invalidStorePath);
    const foreignProbe = (agentId: string) => ({
      agentId,
      env,
      sessionId: `${agentId}-session`,
      sessionKey: `agent:${agentId}:main`,
      storePath: resolveOpenClawAgentSqlitePath({ agentId, env }),
    });
    const unreadable = foreignProbe("unreadable");
    fs.mkdirSync(unreadable.storePath, { recursive: true });

    expect(
      readEvidence([
        probe,
        { ...probe, sessionKey: "agent:worker-1:old-key" },
        { ...probe, sessionId: "missing-session" },
        { ...probe, sessionId: "invalid-session", sessionKey: invalidSessionKey },
        foreignProbe("missing"),
        { ...foreignProbe("migration-invalid"), storePath: invalidStorePath },
        unreadable,
      ]),
    ).toEqual([
      current(sessionKey),
      current(sessionKey),
      absent,
      rowInvalid,
      absent,
      readFailed,
      readFailed,
    ]);
  });

  it("does not prefer a main key when only a shared physical session identity is known", async () => {
    const scope = makeScope("readonly-shared-identity");
    const sessionId = "shared-generation";
    const mainKey = "agent:worker-1:main";
    const otherKey = "agent:worker-1:other";
    for (const sessionKey of [mainKey, otherKey]) {
      await upsertEntry({ ...scope, sessionKey }, { sessionId, updatedAt: 1 });
    }
    const probe = { ...scope, sessionId, storePath: resolveOpenClawAgentSqlitePath(scope) };

    expect(
      readEvidence([probe, { ...probe, sessionKey: mainKey }, { ...probe, sessionKey: otherKey }]),
    ).toEqual([ambiguous, current(mainKey), current(otherKey)]);
  });

  it.each(["identity", "timestamp", "json", "nul", "participant", "participant-integer"])(
    "rejects stale valid %s evidence without relying on a fallback read",
    async (corruption) => {
      const { scope, database, probe, sessionId, sessionKey } = await seedIdentity(
        "readonly-stale-valid-evidence",
      );
      const readableSessionId = "session-2";
      const readableSessionKey = "agent:worker-1:readable";
      await upsertEntry(
        { ...scope, sessionKey: readableSessionKey },
        { sessionId: readableSessionId, updatedAt: 1 },
      );
      expect(readEvidence([probe])).toEqual([current(sessionKey)]);
      if (corruption === "participant" || corruption === "participant-integer") {
        recordSessionParticipant(
          { ...scope, sessionKey },
          { identity: { type: "agent", id: "peer" }, promptedAt: 1 },
        );
        const column = corruption === "participant" ? "identity_namespace" : "contribution_count";
        const value = corruption === "participant" ? "{}" : 9007199254740992n;
        database.db
          .prepare(`UPDATE session_participants SET ${column} = ? WHERE session_key = ?`)
          .run(value, sessionKey);
      } else {
        const entryJson =
          corruption === "json"
            ? "{"
            : JSON.stringify({
                sessionId: corruption === "identity" ? "mismatched-session" : sessionId,
                updatedAt: corruption === "timestamp" ? 2 : 1,
              });
        updateNode(
          database.db,
          sessionKey,
          "entry_json = ?",
          corruption === "nul" ? entryJson + "\0" : entryJson,
        );
      }
      updateNode(database.db, sessionKey, "entry_valid = 1");

      expect(readEvidence([probe])).toEqual([rowInvalid]);

      expect(
        readEvidence([
          probe,
          { ...probe, sessionKey: "agent:worker-1:old-key" },
          { ...probe, sessionId: readableSessionId, sessionKey: readableSessionKey },
        ]),
      ).toEqual([rowInvalid, rowInvalid, current(readableSessionKey)]);
    },
  );

  it("keeps retained identity ambiguity even when the exact key is present", async () => {
    const scope = makeScope("retained-evidence");
    const sessionId = "retained-generation";
    const sessionKey = "agent:worker-1:retained";
    runOpenClawAgentWriteTransaction((database) => {
      ensureTranscriptSessionRoot(database, { ...scope, sessionKey, sessionId }, 1);
    }, scope);
    const storePath = resolveOpenClawAgentSqlitePath(scope);
    const probe = { ...scope, sessionId, sessionKey, storePath };
    expect(readEvidence([probe])).toEqual([absent]);

    const currentKey = "agent:worker-1:current";
    await upsertEntry({ ...scope, sessionKey: currentKey }, { sessionId, updatedAt: 1 });

    expect(
      readEvidence([
        probe,
        { ...probe, sessionKey: currentKey },
        { ...scope, sessionId, storePath },
      ]),
    ).toEqual([ambiguous, current(currentKey), ambiguous]);
  });

  it("validates a later required fallback row after another connection commits", async () => {
    const {
      database,
      sessionId,
      sessionKey,
      probe: exactProbe,
    } = await seedIdentity("evidence-external-commit", "shared-generation");
    const { sessionKey: _key, ...probe } = exactProbe;
    const probes = [{ ...probe, sessionKey }, probe];
    expect(readEvidence(probes)).toEqual([current(sessionKey), current(sessionKey)]);

    const external = new DatabaseSync(database.path);
    const events: string[] = [];
    const nativeDb = requireNativeSqliteDatabase(database.db);
    clearNodeSqliteKyselyCacheForDatabase(nativeDb);
    const originalPrepare = nativeDb.prepare.bind(nativeDb);
    const prepareSpy = vi.spyOn(nativeDb, "prepare").mockImplementation((sqlText) => {
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
          runSqliteImmediateTransactionSync(external, () => {
            updateNode(
              external,
              sessionKey,
              "entry_json = ?, updated_at = ?",
              JSON.stringify({ sessionId, updatedAt: 2 }),
              3,
            );
            updateNode(external, sessionKey, "entry_valid = 1");
          });
          events.push("external-commit");
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
      statement.iterate = function* (...args: unknown[]) {
        yield* originalIterate(...args);
        afterRead();
      } as StatementSync["iterate"];
      return statement;
    });
    try {
      const observed = readEvidence(probes);
      expect(events).toEqual(["exact-read", "external-commit", "fallback-read"]);
      expect(observed).toEqual([rowInvalid, rowInvalid]);
    } finally {
      clearNodeSqliteKyselyCacheForDatabase(nativeDb);
      prepareSpy.mockRestore();
      external.close();
    }
  });
});
