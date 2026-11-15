import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { Worker } from "node:worker_threads";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { sessionChanges, type SessionRowChange } from "../../sessions/session-row-changes.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
  isOpenClawAgentDatabaseOpen,
  openOpenClawAgentDatabase,
  resolveOpenClawAgentSqlitePath,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { captureRuntimeConfigAsyncReader } from "../io.runtime.js";
import {
  deleteSessionEntryLifecycle,
  loadSessionEntry,
  upsertSessionEntryCore,
} from "./session-accessor.js";
import * as sqliteArchive from "./session-accessor.sqlite-archive.js";
import * as reclamation from "./session-accessor.sqlite-reclamation-run.js";
import { createSessionMaintenanceFinalizationOperation as finalization } from "./session-accessor.sqlite-reclamation.js";
import { readSessionMembersInWorker } from "./session-sharing-store.js";
import { listSessionMembersInDatabase } from "./session-sharing-store.kernel.js";
import { addSessionMember, removeSessionMember } from "./session-sharing-store.native.js";

function memberRow(identityId: string, addedAt: number, addedBy = "owner") {
  return { identityId, addedBy, addedAt };
}

type Scope = { agentId: string; env: NodeJS.ProcessEnv; sessionKey: string };
const readMembers = async (scope: Scope) => (await readSessionMembersInWorker(scope)).members;
function sharing(scope: Scope) {
  return {
    add: (identityId: string, addedAt = 2, expectedSessionId?: string) =>
      addSessionMember(scope, { ...memberRow(identityId, addedAt), expectedSessionId }),
    remove: (
      identityId: string,
      expected?: Parameters<typeof removeSessionMember>[2],
      sessionId?: string,
    ) => removeSessionMember(scope, identityId, expected, sessionId),
    read: () => readMembers(scope),
    entry: () => loadSessionEntry(scope),
    update: (sessionId: string, updatedAt: number, visibility?: "read-only") =>
      upsertSessionEntryCore(scope, { sessionId, updatedAt, visibility }),
  };
}

async function withSharingState(
  run: (scope: Scope, operations: ReturnType<typeof sharing>) => Promise<void>,
  entry: Parameters<typeof upsertSessionEntryCore>[1] = { sessionId: "session-main", updatedAt: 1 },
) {
  await withOpenClawTestState({ layout: "state-only" }, async ({ env }) => {
    await captureRuntimeConfigAsyncReader()();
    const scope = { agentId: "main", env, sessionKey: "agent:main:main" };
    await upsertSessionEntryCore(scope, entry);
    await run(scope, sharing(scope));
  });
}

afterEach(() => vi.restoreAllMocks());

it("joins exited maintenance leases before removing sharing fixture state", async () => {
  let fixtureRoot = "";
  const workers: Worker[] = [];
  const maintenance = createDeferred<{
    raw: ReturnType<typeof reclamation.runSqliteSessionReclamation>;
  }>();
  const spawn = sqliteArchive.createSqliteTranscriptArchiveWorker;
  vi.spyOn(sqliteArchive, "createSqliteTranscriptArchiveWorker").mockImplementation(
    (data, nativeLocations) => {
      const worker = spawn(data, nativeLocations);
      const databaseOptions = expect.objectContaining({
        env: expect.objectContaining({ OPENCLAW_STATE_DIR: fixtureRoot }),
      });
      if (
        expect
          .objectContaining({
            type: "sqlite-transcript-archive-v2",
            operation: "reclaim",
            databaseOptions,
          })
          .asymmetricMatch(data)
      ) {
        workers.push(worker);
      }
      return worker;
    },
  );
  const run = reclamation.runSqliteSessionReclamation;
  vi.spyOn(reclamation, "runSqliteSessionReclamation").mockImplementation((params) => {
    const raw = run(params);
    if (
      params.plan.kind === "maintenance-plan" &&
      params.plan.databaseOptions.env?.OPENCLAW_STATE_DIR === fixtureRoot
    ) {
      maintenance.resolve({ raw });
    }
    return raw;
  });
  await withOpenClawTestState({ layout: "state-only" }, async ({ stateDir: dir, env }) => {
    await captureRuntimeConfigAsyncReader()();
    fixtureRoot = dir;
    const scope = { agentId: "main", env, sessionKey: "agent:main:main" };
    await upsertSessionEntryCore(scope, { sessionId: "session-main", updatedAt: 1 });
    expect(isOpenClawAgentDatabaseOpen(resolveOpenClawAgentSqlitePath(scope))).toBe(false);
    const sql = observeHostDataSql();
    try {
      expect(await (await maintenance.promise).raw).toMatchObject({ kind: "maintenance-plan" });
      expect(
        sql.queries.filter((query) =>
          /session_nodes|session_entry_snapshots|\bCOMMIT\b|\bBEGIN IMMEDIATE\b/i.test(query),
        ),
      ).toEqual([]);
    } finally {
      sql.restore();
    }
    expect(isOpenClawAgentDatabaseOpen(resolveOpenClawAgentSqlitePath(scope))).toBe(false);
    await expect(
      reclamation.runSqliteSessionReclamation({
        plan: finalization({
          agentId: scope.agentId,
          databaseOptions: scope,
          entries: [],
          materializedPlans: [],
        }),
      }),
    ).resolves.toMatchObject({ kind: "maintenance-finalize" });
    expect(workers).toHaveLength(1);
    const worker = workers[0];
    if (!worker) {
      throw new Error("Expected the archive maintenance worker");
    }
    // Parent-owned lease cleanup still needs the original store after native exit.
    await worker.terminate();
  });
  expect(fs.existsSync(fixtureRoot)).toBe(false);
  await closeOpenClawAgentDatabasesAsync(fixtureRoot);
});

it("publishes membership changes only after their containing transaction commits", async () => {
  await withSharingState(async (scope, { add, remove }) => {
    const changes: SessionRowChange[] = [];
    const members: string[][] = [];
    const fact = (identityId: string, present: boolean) => ({
      kind: "member",
      sessionId: "session-main",
      identityId,
      present,
    });
    const database = openOpenClawAgentDatabase(scope);
    const stopFacts = sessionChanges.subscribeFacts((change) => changes.push(change));
    const stop = sessionChanges.subscribe(() => {
      members.push(
        listSessionMembersInDatabase(database, scope.sessionKey).map((member) => member.identityId),
      );
    });
    try {
      runOpenClawAgentWriteTransaction(() => {
        add("guest");
        expect(changes).toEqual([]);
      }, scope);
      expect(changes).toEqual([
        expect.objectContaining({
          agentId: scope.agentId,
          sessionKey: scope.sessionKey,
          storePath: resolveOpenClawAgentSqlitePath(scope),
          facts: fact("guest", true),
        }),
      ]);
      expect(members).toEqual([["guest"]]);
      changes.length = 0;
      members.length = 0;
      expect(() =>
        runOpenClawAgentWriteTransaction(() => {
          remove("guest");
          expect(changes).toEqual([]);
          throw new Error("rollback");
        }, scope),
      ).toThrow("rollback");
      expect(changes).toEqual([]);
      remove("guest");
      expect(members).toEqual([[]]);
      changes.length = 0;
      members.length = 0;
      runOpenClawAgentWriteTransaction(() => {
        add("transient");
        remove("transient");
        expect(changes).toEqual([]);
      }, scope);
      expect(members).toEqual([[], []]);
      expect(changes.map((change) => ("sessionKey" in change ? change.facts : undefined))).toEqual(
        [true, false].map((present) => fact("transient", present)),
      );
    } finally {
      stop();
      stopFacts();
    }
  });
});

it("reads existing and missing memberships without opening or creating writable databases", async () => {
  await withSharingState(async (scope) => {
    const missingScope = { ...scope, agentId: "missing", sessionKey: "agent:missing:main" };
    addSessionMember(scope, memberRow("guest", 2));
    const databasePath = resolveOpenClawAgentSqlitePath(scope);
    const missingPath = resolveOpenClawAgentSqlitePath(missingScope);
    await closeOpenClawAgentDatabasesAsync();
    closeOpenClawAgentDatabasesForTest();

    expect(await readMembers(scope)).toEqual([memberRow("guest", 2)]);
    expect(isOpenClawAgentDatabaseOpen(databasePath)).toBe(false);
    expect(await readMembers(missingScope)).toEqual([]);
    expect(fs.existsSync(missingPath)).toBe(false);
  });
});

it("does not recreate a missing canonical membership table", async () => {
  await withSharingState(async (scope) => {
    const databasePath = resolveOpenClawAgentSqlitePath(scope);
    // Corrupt an offline fixture, not a store whose workers still hold admission receipts.
    await closeOpenClawAgentDatabasesAsync();
    closeOpenClawAgentDatabasesForTest();
    using database = new DatabaseSync(databasePath);
    database.exec("DROP TABLE session_members;");

    await expect(readSessionMembersInWorker(scope)).rejects.toThrow(
      expect.objectContaining({
        name: "SessionMetadataUnavailableError",
        reason: "table-missing",
        missingTables: ["session_members"],
        cause: expect.objectContaining({
          message: expect.stringMatching(/no such table: session_members/),
        }),
      }),
    );
    expect(
      database
        .prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'session_members'")
        .get(),
    ).toBeUndefined();
  });
});

it("does not remove a newer membership grant using an older grant", async () => {
  await withSharingState(
    async (_, { add, remove, read, entry }) => {
      expect(entry()?.visibility).toBe("shared");
      expect(await read()).toEqual([]);
      const original = add("guest").member;
      expect(remove("guest", original)).toEqual(original);
      const replacement = add("guest", 3).member;

      expect(remove("guest", original)).toBeNull();
      expect(await read()).toEqual([replacement]);
      expect(remove("guest", replacement)).toEqual(replacement);
      expect(await read()).toEqual([]);
      expect(remove("guest")).toBeNull();
    },
    { sessionId: "session-main", updatedAt: 1, visibility: "shared" },
  );
});

it("refuses member writes whose expected session instance no longer matches", async () => {
  await withSharingState(
    async (_, { add, remove, read }) => {
      expect(() => add("stale", 2, "session-a")).toThrow(/session changed/);
      expect(await read()).toEqual([]);

      expect(add("ok", 2, "session-b").inserted).toBe(true);
      expect(() => remove("ok", undefined, "session-a")).toThrow(/session changed/);
      expect(await read()).toEqual([expect.objectContaining({ identityId: "ok" })]);
    },
    { sessionId: "session-b", updatedAt: 1 },
  );
});

it.each([
  ["identity without timestamps", "session-a", '{"sessionId":"session-a"}', true],
  ["empty identity", "", '{"sessionId":""}', true],
  ["opaque identity", " a\0🦞 ", JSON.stringify({ sessionId: " a\0🦞 " }), true],
  ["mismatched node", "session-b", '{"sessionId":"session-a"}', false],
  ["malformed JSON", "session-a", "{", false],
  ["array JSON", "session-a", '[{"sessionId":"session-a"}]', false],
  ["last duplicate wins", "session-a", '{"sessionId":false,"sessionId":"session-a"}', true],
  ["last duplicate invalid", "session-a", '{"sessionId":"session-a","sessionId":false}', false],
  ["literal NUL", "session-a", '{"sessionId":"session-a"}\0', false],
] as const)(
  "preserves membership identity checks for %s",
  async (_, sessionId, entryJson, valid) => {
    await withSharingState(
      async (scope, { add, remove }) => {
        add("existing");
        const database = openOpenClawAgentDatabase(scope);
        database.db
          .prepare(
            "UPDATE session_nodes SET current_session_id = ?, entry_json = ? WHERE session_key = ?",
          )
          .run(sessionId, entryJson, scope.sessionKey);

        const addNew = () => add("new", 3);
        const removeExisting = () => remove("existing");
        if (valid) {
          expect(addNew().inserted).toBe(true);
          expect(removeExisting()).toEqual(memberRow("existing", 2));
        } else {
          expect(addNew).toThrow("session changed before sharing mutation");
          expect(removeExisting).toThrow("session changed before sharing mutation");
          expect(listSessionMembersInDatabase(database, scope.sessionKey)).toEqual([
            memberRow("existing", 2),
          ]);
        }
      },
      { sessionId: "session-a", updatedAt: 1 },
    );
  },
);

it("drops members when the session instance is replaced under the same key", async () => {
  await withSharingState(
    async (_, { add, read, entry, update }) => {
      expect(add("guest").inserted).toBe(true);
      await update("session-b", 3, "read-only");
      expect(await read()).toEqual([]);
      expect(entry()?.visibility).toBeUndefined();
      expect(add("guest", 4).inserted).toBe(true);
      await update("session-b", 5);
      expect(await read()).toEqual([expect.objectContaining({ identityId: "guest" })]);
    },
    { sessionId: "session-a", updatedAt: 1, visibility: "read-only" },
  );
});

it("rejects stale member writes after entry-only deletion leaves a placeholder", async () => {
  await withSharingState(
    async (scope, { add, read, entry, update }) => {
      expect(add("guest").inserted).toBe(true);

      await deleteSessionEntryLifecycle({
        agentId: "main",
        archiveTranscript: false,
        storePath: openOpenClawAgentDatabase(scope).path,
        target: { canonicalKey: scope.sessionKey, storeKeys: [scope.sessionKey] },
      });

      expect(entry()).toBeUndefined();
      expect(await read()).toEqual([]);
      expect(() => add("stale", 2, "session-a")).toThrow(/session changed/);
      expect(() => add("planted")).toThrow(/session changed/);

      await update("session-b", 3);
      expect(await read()).toEqual([]);
    },
    { sessionId: "session-a", updatedAt: 1 },
  );
});
