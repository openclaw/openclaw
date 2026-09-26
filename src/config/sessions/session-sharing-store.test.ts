import fs from "node:fs";
import type { Worker } from "node:worker_threads";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
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
import {
  deleteSessionEntryLifecycle,
  loadSessionEntry,
  upsertSessionEntryCore,
} from "./session-accessor.js";
import * as sqliteArchive from "./session-accessor.sqlite-archive.js";
import * as reclamation from "./session-accessor.sqlite-reclamation.js";
import { isSessionMember, listSessionMembers } from "./session-sharing-store.js";
import { addSessionMember, removeSessionMember } from "./session-sharing-store.native.js";

const stateOptions = { layout: "state-only" as const, applyEnv: false };

afterEach(() => vi.restoreAllMocks());

describe("session sharing store", () => {
  it("joins exited maintenance leases before removing sharing fixture state", async () => {
    let fixtureRoot = "";
    const workers: Worker[] = [];
    const maintenance = createDeferred<{
      raw: ReturnType<typeof reclamation.runSqliteSessionReclamation>;
    }>();
    const spawn = sqliteArchive.createSqliteTranscriptArchiveWorker;
    vi.spyOn(sqliteArchive, "createSqliteTranscriptArchiveWorker").mockImplementation((data) => {
      const worker = spawn(data);
      if (
        expect
          .objectContaining({
            type: "sqlite-transcript-archive-v2",
            operation: "reclaim",
            databaseOptions: expect.objectContaining({
              env: expect.objectContaining({ OPENCLAW_STATE_DIR: fixtureRoot }),
            }),
          })
          .asymmetricMatch(data)
      ) {
        workers.push(worker);
      }
      return worker;
    });
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
    await withOpenClawTestState(stateOptions, async ({ stateDir: dir }) => {
      fixtureRoot = dir;
      const scope = {
        agentId: "main",
        env: { ...process.env, OPENCLAW_STATE_DIR: dir },
        sessionKey: "agent:main:main",
      };
      await upsertSessionEntryCore(scope, { sessionId: "session-main", updatedAt: 1 });
      await expect((await maintenance.promise).raw).resolves.toMatchObject({
        kind: "maintenance-plan",
      });
      expect(workers).toHaveLength(1);
      const worker = workers[0];
      if (!worker) {
        throw new Error("Expected the automatic maintenance worker");
      }
      // Parent-owned lease cleanup still needs the original store after native exit.
      await worker.terminate();
    });
    expect(fs.existsSync(fixtureRoot)).toBe(false);
    await closeOpenClawAgentDatabasesAsync(fixtureRoot);
  });

  it("publishes membership changes only after their containing transaction commits", async () => {
    await withOpenClawTestState(stateOptions, async ({ stateDir: dir }) => {
      const env = { ...process.env, OPENCLAW_STATE_DIR: dir };
      const scope = { agentId: "main", env, sessionKey: "agent:main:main" };
      await upsertSessionEntryCore(scope, { sessionId: "session-main", updatedAt: 1 });
      const changes: SessionRowChange[] = [];
      const members: string[][] = [];
      const stopFacts = sessionChanges.subscribeFacts((change) => changes.push(change));
      const stop = sessionChanges.subscribe(() => {
        members.push(listSessionMembers(scope).map((member) => member.identityId));
      });
      try {
        runOpenClawAgentWriteTransaction(
          () => {
            addSessionMember(scope, { identityId: "guest", addedBy: "owner" });
            expect(changes).toEqual([]);
          },
          { agentId: scope.agentId, env },
        );
        expect(changes).toEqual([
          expect.objectContaining({
            agentId: scope.agentId,
            sessionKey: scope.sessionKey,
            storePath: resolveOpenClawAgentSqlitePath({ agentId: scope.agentId, env }),
            facts: {
              kind: "member",
              sessionId: "session-main",
              identityId: "guest",
              present: true,
            },
          }),
        ]);
        expect(members).toEqual([["guest"]]);
        changes.length = 0;
        members.length = 0;
        expect(() =>
          runOpenClawAgentWriteTransaction(
            () => {
              removeSessionMember(scope, "guest");
              expect(changes).toEqual([]);
              throw new Error("rollback");
            },
            { agentId: scope.agentId, env },
          ),
        ).toThrow("rollback");
        expect(changes).toEqual([]);
        removeSessionMember(scope, "guest");
        expect(members).toEqual([[]]);
        changes.length = 0;
        members.length = 0;
        runOpenClawAgentWriteTransaction(
          () => {
            addSessionMember(scope, { identityId: "transient", addedBy: "owner" });
            removeSessionMember(scope, "transient");
            expect(changes).toEqual([]);
          },
          { agentId: scope.agentId, env },
        );
        expect(members).toEqual([[], []]);
        expect(
          changes.map((change) => ("sessionKey" in change ? change.facts : undefined)),
        ).toEqual([
          { kind: "member", sessionId: "session-main", identityId: "transient", present: true },
          { kind: "member", sessionId: "session-main", identityId: "transient", present: false },
        ]);
      } finally {
        stop();
        stopFacts();
      }
    });
  });

  it("reads existing and missing memberships without opening or creating writable databases", async () => {
    await withOpenClawTestState(stateOptions, async ({ stateDir: dir }) => {
      const env = { ...process.env, OPENCLAW_STATE_DIR: dir };
      const scope = { agentId: "main", env, sessionKey: "agent:main:main" };
      const missingScope = { agentId: "missing", env, sessionKey: "agent:missing:main" };
      await upsertSessionEntryCore(scope, { sessionId: "session-main", updatedAt: 1 });
      addSessionMember(scope, { identityId: "guest", addedBy: "owner", addedAt: 2 });
      const databasePath = resolveOpenClawAgentSqlitePath({ agentId: scope.agentId, env });
      const missingPath = resolveOpenClawAgentSqlitePath({ agentId: missingScope.agentId, env });
      closeOpenClawAgentDatabasesForTest();

      expect(listSessionMembers(scope)).toEqual([
        { identityId: "guest", addedBy: "owner", addedAt: 2 },
      ]);
      expect(isSessionMember(scope, "guest")).toBe(true);
      expect(isOpenClawAgentDatabaseOpen(databasePath)).toBe(false);
      expect(listSessionMembers(missingScope)).toEqual([]);
      expect(isSessionMember(missingScope, "guest")).toBe(false);
      expect(fs.existsSync(missingPath)).toBe(false);
    });
  });

  it("keeps deterministic membership rows", async () => {
    await withOpenClawTestState(stateOptions, async ({ stateDir: dir }) => {
      const env = { ...process.env, OPENCLAW_STATE_DIR: dir };
      const scope = { agentId: "main", env, sessionKey: "agent:main:main" };
      await upsertSessionEntryCore(scope, {
        sessionId: "session-main",
        updatedAt: 1,
        visibility: "shared",
      });
      expect(loadSessionEntry(scope)?.visibility).toBe("shared");

      expect(listSessionMembers(scope)).toEqual([]);
      expect(
        addSessionMember(scope, { identityId: "zoe", addedBy: "owner", addedAt: 2 }).inserted,
      ).toBe(true);
      expect(
        addSessionMember(scope, { identityId: "alice", addedBy: "owner", addedAt: 3 }).inserted,
      ).toBe(true);

      expect(listSessionMembers(scope)).toEqual([
        { identityId: "alice", addedBy: "owner", addedAt: 3 },
        { identityId: "zoe", addedBy: "owner", addedAt: 2 },
      ]);
      expect(isSessionMember(scope, "alice")).toBe(true);
      expect(removeSessionMember(scope, "alice")).toEqual({
        identityId: "alice",
        addedBy: "owner",
        addedAt: 3,
      });
      expect(removeSessionMember(scope, "alice")).toBeNull();
    });
  });

  it("does not recreate a missing canonical membership table", async () => {
    await withOpenClawTestState(stateOptions, async ({ stateDir: dir }) => {
      const env = { ...process.env, OPENCLAW_STATE_DIR: dir };
      const scope = { agentId: "main", env, sessionKey: "agent:main:main" };
      await upsertSessionEntryCore(scope, { sessionId: "session-main", updatedAt: 1 });
      const database = openOpenClawAgentDatabase({ agentId: "main", env });
      database.db.exec("DROP TABLE session_members;");

      expect(() => listSessionMembers(scope)).toThrow(
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
        database.db
          .prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'session_members'")
          .get(),
      ).toBeUndefined();
    });
  });

  it("refuses member writes whose expected session instance no longer matches", async () => {
    await withOpenClawTestState(stateOptions, async ({ stateDir: dir }) => {
      const env = { ...process.env, OPENCLAW_STATE_DIR: dir };
      const scope = { agentId: "main", env, sessionKey: "agent:main:main" };
      await upsertSessionEntryCore(scope, { sessionId: "session-b", updatedAt: 1 });

      // A write authorized against a now-replaced instance must not mutate the
      // live one under the same key.
      expect(() =>
        addSessionMember(scope, {
          identityId: "stale",
          addedBy: "owner",
          expectedSessionId: "session-a",
        }),
      ).toThrow(/session changed/);
      expect(listSessionMembers(scope)).toEqual([]);

      expect(
        addSessionMember(scope, {
          identityId: "ok",
          addedBy: "owner",
          addedAt: 2,
          expectedSessionId: "session-b",
        }).inserted,
      ).toBe(true);
      expect(() => removeSessionMember(scope, "ok", undefined, "session-a")).toThrow(
        /session changed/,
      );
      expect(isSessionMember(scope, "ok")).toBe(true);
    });
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
      await withOpenClawTestState(stateOptions, async ({ stateDir: dir }) => {
        const env = { ...process.env, OPENCLAW_STATE_DIR: dir };
        const scope = { agentId: "main", env, sessionKey: "agent:main:main" };
        await upsertSessionEntryCore(scope, { sessionId: "session-a", updatedAt: 1 });
        addSessionMember(scope, { identityId: "existing", addedBy: "owner", addedAt: 2 });
        const database = openOpenClawAgentDatabase({ agentId: "main", env });
        database.db
          .prepare(
            "UPDATE session_nodes SET current_session_id = ?, entry_json = ? WHERE session_key = ?",
          )
          .run(sessionId, entryJson, scope.sessionKey);

        const add = () =>
          addSessionMember(scope, { identityId: "new", addedBy: "owner", addedAt: 3 });
        const remove = () => removeSessionMember(scope, "existing");
        if (valid) {
          expect(add().inserted).toBe(true);
          expect(remove()).toEqual({ identityId: "existing", addedBy: "owner", addedAt: 2 });
        } else {
          expect(add).toThrow("session changed before sharing mutation");
          expect(remove).toThrow("session changed before sharing mutation");
          expect(listSessionMembers(scope)).toEqual([
            { identityId: "existing", addedBy: "owner", addedAt: 2 },
          ]);
        }
      });
    },
  );

  it("drops members when the session instance is replaced under the same key", async () => {
    await withOpenClawTestState(stateOptions, async ({ stateDir: dir }) => {
      const env = { ...process.env, OPENCLAW_STATE_DIR: dir };
      const scope = { agentId: "main", env, sessionKey: "agent:main:main" };
      await upsertSessionEntryCore(scope, {
        sessionId: "session-a",
        updatedAt: 1,
        visibility: "read-only",
      });
      expect(
        addSessionMember(scope, { identityId: "guest", addedBy: "owner", addedAt: 2 }).inserted,
      ).toBe(true);
      expect(isSessionMember(scope, "guest")).toBe(true);

      // Reusing the canonical key with a new sessionId is a fresh session; a
      // stale member must not inherit access, and the replacement must start
      // shared even if the recreated entry copied a restricted visibility.
      await upsertSessionEntryCore(scope, {
        sessionId: "session-b",
        updatedAt: 3,
        visibility: "read-only",
      });
      expect(listSessionMembers(scope)).toEqual([]);
      expect(isSessionMember(scope, "guest")).toBe(false);
      // Replacement drops the copied restriction; absent visibility reads as
      // shared, so the fresh instance is not hidden or read-only.
      expect(loadSessionEntry(scope)?.visibility).toBeUndefined();

      // An in-place update that keeps the same sessionId preserves membership.
      expect(
        addSessionMember(scope, { identityId: "guest", addedBy: "owner", addedAt: 4 }).inserted,
      ).toBe(true);
      await upsertSessionEntryCore(scope, { sessionId: "session-b", updatedAt: 5 });
      expect(isSessionMember(scope, "guest")).toBe(true);
    });
  });

  it("rejects stale member writes after entry-only deletion leaves a placeholder", async () => {
    await withOpenClawTestState(stateOptions, async ({ stateDir: dir }) => {
      const env = { ...process.env, OPENCLAW_STATE_DIR: dir };
      const scope = { agentId: "main", env, sessionKey: "agent:main:main" };
      await upsertSessionEntryCore(scope, { sessionId: "session-a", updatedAt: 1 });
      expect(
        addSessionMember(scope, { identityId: "guest", addedBy: "owner", addedAt: 2 }).inserted,
      ).toBe(true);

      await deleteSessionEntryLifecycle({
        agentId: "main",
        archiveTranscript: false,
        storePath: openOpenClawAgentDatabase({ agentId: "main", env }).path,
        target: { canonicalKey: scope.sessionKey, storeKeys: [scope.sessionKey] },
      });

      expect(loadSessionEntry(scope)).toBeUndefined();
      expect(listSessionMembers(scope)).toEqual([]);
      expect(() =>
        addSessionMember(scope, {
          identityId: "stale",
          addedBy: "owner",
          expectedSessionId: "session-a",
        }),
      ).toThrow(/session changed/);
      expect(() =>
        addSessionMember(scope, {
          identityId: "planted",
          addedBy: "owner",
        }),
      ).toThrow(/session changed/);

      await upsertSessionEntryCore(scope, { sessionId: "session-b", updatedAt: 3 });
      expect(listSessionMembers(scope)).toEqual([]);
    });
  });
});
