import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { trackSqliteStatementExecutions } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { onSessionLifecycleEvent } from "../../sessions/session-lifecycle-events.js";
import {
  closeOpenClawAgentDatabasesForTest,
  deferOpenClawAgentPostCommitPublication,
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { ensureProfileForEmail, linkEmail } from "../../state/user-profiles.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  assignSessionOwner,
  deleteSessionEntryLifecycle,
  listSessionParticipantsReadOnly,
  listSessionEntriesCore,
  loadExactSessionEntryCandidatesReadOnlyBatch,
  loadSessionEntry,
  MAX_SESSION_PARTICIPANTS,
  patchSessionEntryCore,
  upsertSessionEntryCore,
} from "./session-accessor.js";
import { writeSessionEntry } from "./session-accessor.sqlite-entry-store.js";
import { copySessionNodeArtifactsForRepair } from "./session-accessor.sqlite-node-artifacts.js";
import { recordSessionParticipant } from "./session-accessor.sqlite-participants.native.js";
import type { SessionParticipantIdentity } from "./session-participant-identity.js";

const profile = (id: string): SessionParticipantIdentity => ({ type: "profile", id });
const remote = (id: string, domain = "workspace"): SessionParticipantIdentity => ({
  type: "remote",
  pluginId: "test-channel",
  domain,
  idKind: "user",
  id,
});

afterEach(() => closeOpenClawAgentDatabasesForTest());

describe("SQLite session participants", () => {
  it("commits a prepared node patch without newly decoding invalid participant rows", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const scope = {
        agentId: "main",
        env: state.env,
        sessionKey: "agent:main:prepared",
        projection: "list" as const,
      };
      await upsertSessionEntryCore(scope, { sessionId: "prepared", updatedAt: 1 });
      recordSessionParticipant(scope, { identity: remote("before"), promptedAt: 1 });
      expect(listSessionEntriesCore(scope)).toHaveLength(1);
      const prepared = createDeferred();
      const resume = createDeferred();
      const patch = patchSessionEntryCore(
        scope,
        async () => {
          prepared.resolve();
          await resume.promise;
          return { label: "committed" };
        },
        { skipMaintenance: true },
      );
      try {
        await prepared.promise;
        recordSessionParticipant(scope, { identity: remote("before"), promptedAt: 2 });
        const database = openOpenClawAgentDatabase(scope);
        database.db
          .prepare("UPDATE session_participants SET identity_namespace = ? WHERE session_key = ?")
          .run('{"type":"profile","extra":true}', scope.sessionKey);
        resume.resolve();
        await expect(patch).resolves.toMatchObject({ sessionId: "prepared", label: "committed" });
        expect(() => listSessionEntriesCore(scope)).toThrow(
          "Session participant identity is invalid; run openclaw doctor --fix.",
        );
        database.db.prepare("DELETE FROM session_participants").run();
        expect(listSessionEntriesCore(scope)[0]?.entry.label).toBe("committed");
      } finally {
        resume.resolve();
        await patch.catch(() => {});
      }
    });
  });

  it.each(["participant", "entry", "external-entry"] as const)(
    "keeps a reentrant observer's newer cached state after an outer %s write",
    async (kind) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const scope = { agentId: "main", env: state.env, sessionKey: "agent:main:reentrant" };
        await upsertSessionEntryCore(scope, {
          sessionId: "reentrant",
          updatedAt: 1,
          label: "a",
        });
        recordSessionParticipant(scope, { identity: profile("a"), promptedAt: 10 });
        const read = () =>
          listSessionEntriesCore({ ...scope, projection: "list" }).find(
            (row) => row.sessionKey === scope.sessionKey,
          )?.entry;
        read();
        const write = (label: string, time: number, external = false) => {
          if (kind === "participant") {
            recordSessionParticipant(scope, { identity: profile(label), promptedAt: time });
          } else if (external) {
            const database = new DatabaseSync(openOpenClawAgentDatabase(scope).path);
            try {
              database
                .prepare(
                  "UPDATE session_nodes SET entry_json = json_set(entry_json, '$.label', ?, '$.updatedAt', ?), updated_at = ? WHERE session_key = ?",
                )
                .run(label, time, time, scope.sessionKey);
            } finally {
              database.close();
            }
          } else {
            runOpenClawAgentWriteTransaction((database) => {
              writeSessionEntry(database, scope.sessionKey, {
                sessionId: "reentrant",
                updatedAt: time,
                label,
              });
            }, scope);
          }
        };
        const expected =
          kind === "participant"
            ? {
                participants: ["a", "b", "c"].map((id) => ({ identity: profile(id) })),
                participantCount: 3,
              }
            : { label: "c", updatedAt: 30 };
        let observed: ReturnType<typeof read>;
        runOpenClawAgentWriteTransaction((database) => {
          deferOpenClawAgentPostCommitPublication(database, () => {
            write("c", 30, kind === "external-entry");
            observed = read();
          });
          write("b", 20);
        }, scope);
        expect(observed).toMatchObject(expected);
        expect(read()).toMatchObject(expected);
      });
    },
  );

  it("reinstalls participant tracking after first-use schema rollback and immediate retry", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const scope = { agentId: "main", env: state.env };
      const target = { ...scope, sessionKey: "agent:main:target" };
      const sibling = { ...scope, sessionKey: "agent:main:sibling" };
      for (const entryScope of [target, sibling]) {
        await upsertSessionEntryCore(entryScope, {
          sessionId: entryScope.sessionKey,
          updatedAt: 1,
        });
      }
      const database = openOpenClawAgentDatabase(scope);
      database.db.exec("DROP TABLE session_participants");
      const read = () => listSessionEntriesCore({ ...scope, projection: "list" });
      read();
      expect(() =>
        runOpenClawAgentWriteTransaction(() => {
          recordSessionParticipant(target, { identity: profile("a"), promptedAt: 10 });
          throw new Error("rollback schema");
        }, scope),
      ).toThrow("rollback schema");
      // Retry before a cache read can observe the rolled-back schema version.
      recordSessionParticipant(target, { identity: profile("a"), promptedAt: 10 });
      recordSessionParticipant(sibling, { identity: profile("a"), promptedAt: 10 });
      database.db
        .prepare("UPDATE session_participants SET identity_namespace = ? WHERE session_key = ?")
        .run('{"type":"profile","extra":true}', sibling.sessionKey);
      recordSessionParticipant(target, { identity: profile("b"), promptedAt: 20 });
      expect(read).toThrow("Session participant identity is invalid");
    });
  });

  it.each(
    ["participant-before", "participant-after", "external-participant", "session-before"].flatMap(
      (mutation) =>
        ["inserted-target", "stable-repeat-target"].map((write) => ({ mutation, write })),
    ),
  )(
    "does not hide an untracked sibling change during participant publication: $mutation, $write",
    async ({ mutation, write }) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const scope = { agentId: "main", env: state.env };
        const target = { ...scope, sessionKey: "agent:main:target" };
        const sibling = { ...scope, sessionKey: "agent:main:sibling" };
        for (const entryScope of [target, sibling]) {
          await upsertSessionEntryCore(entryScope, {
            sessionId: entryScope.sessionKey,
            updatedAt: 1,
          });
          recordSessionParticipant(entryScope, { identity: profile("a"), promptedAt: 10 });
        }
        const database = openOpenClawAgentDatabase(scope);
        const read = () => listSessionEntriesCore({ ...scope, projection: "list" });
        read();
        const mutate = (db: DatabaseSync) => {
          if (mutation === "session-before") {
            db.prepare(
              "UPDATE session_nodes SET entry_json = json_set(entry_json, '$.label', 'changed') WHERE session_key = ?",
            ).run(sibling.sessionKey);
          } else {
            db.prepare(
              "UPDATE session_participants SET identity_namespace = ? WHERE session_key = ?",
            ).run('{"type":"profile","extra":true}', sibling.sessionKey);
          }
        };
        if (mutation === "external-participant") {
          const external = new DatabaseSync(database.path);
          try {
            mutate(external);
          } finally {
            external.close();
          }
        }
        runOpenClawAgentWriteTransaction((db) => {
          if (mutation.endsWith("before")) {
            mutate(db.db);
          }
          recordSessionParticipant(target, {
            identity: profile(write === "inserted-target" ? "b" : "a"),
            promptedAt: 20,
          });
          if (mutation === "participant-after") {
            mutate(db.db);
          }
        }, scope);
        expect(listSessionParticipantsReadOnly(target).get(target.sessionKey)).toHaveLength(
          write === "inserted-target" ? 2 : 1,
        );
        if (mutation === "session-before") {
          expect(read().find((row) => row.sessionKey === sibling.sessionKey)?.entry.label).toBe(
            "changed",
          );
        } else {
          expect(read).toThrow("Session participant identity is invalid");
        }
      });
    },
  );

  it.each(["insert", "stable-repeat"])(
    "refuses a participant %s inside a raw transaction without changing its rows",
    async (write) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const scope = { agentId: "main", env: state.env, sessionKey: "agent:main:raw-transaction" };
        await upsertSessionEntryCore(scope, { sessionId: "raw-transaction", updatedAt: 1 });
        recordSessionParticipant(scope, { identity: profile("a"), promptedAt: 10 });
        const read = () => listSessionEntriesCore({ ...scope, projection: "list" });
        const before = read();
        const participantsBefore = listSessionParticipantsReadOnly(scope).get(scope.sessionKey);
        const database = openOpenClawAgentDatabase(scope);
        const rows = database.db.prepare(
          "SELECT * FROM session_participants ORDER BY actor_id, identity_namespace",
        );
        const rowsBefore = rows.all();
        database.db.exec("BEGIN");
        try {
          expect(() =>
            recordSessionParticipant(scope, {
              identity: profile(write === "insert" ? "b" : "a"),
              promptedAt: 20,
            }),
          ).toThrow("must use runOpenClawAgentWriteTransaction");
          expect(rows.all()).toEqual(rowsBefore);
        } finally {
          database.db.exec("ROLLBACK");
        }
        expect(read()).toEqual(before);
        expect(listSessionParticipantsReadOnly(scope).get(scope.sessionKey)).toEqual(
          participantsBefore,
        );
      });
    },
  );

  it("publishes the final participant view only after the outer transaction commits", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const scope = {
        agentId: "main",
        env: state.env,
        sessionKey: "agent:main:participant-events",
      };
      await upsertSessionEntryCore(scope, { sessionId: "participant-events", updatedAt: 1 });
      recordSessionParticipant(scope, { identity: profile("a"), promptedAt: 10 });
      const read = () =>
        listSessionEntriesCore({ ...scope, projection: "list" }).find(
          (row) => row.sessionKey === scope.sessionKey,
        )?.entry;
      read();
      const database = openOpenClawAgentDatabase(scope);
      const observed: Array<{ inTransaction: boolean; entry: ReturnType<typeof read> }> = [];
      const unsubscribe = onSessionLifecycleEvent((event) => {
        if (
          event.reason === "participants" &&
          event.agentId === scope.agentId &&
          event.sessionKey === scope.sessionKey
        ) {
          observed.push({ inTransaction: database.db.isTransaction, entry: read() });
        }
      });
      try {
        expect(() =>
          runOpenClawAgentWriteTransaction(() => {
            recordSessionParticipant(scope, { identity: profile("a"), promptedAt: 20 });
            expect(observed).toEqual([]);
            throw new Error("rollback participant");
          }, scope),
        ).toThrow("rollback participant");
        expect(observed).toEqual([]);
        runOpenClawAgentWriteTransaction(() => {
          recordSessionParticipant(scope, { identity: profile("a"), promptedAt: 30 });
          runOpenClawAgentWriteTransaction(() => {
            recordSessionParticipant(scope, { identity: profile("b"), promptedAt: 40 });
          }, scope);
          expect(observed).toEqual([]);
        }, scope);
        expect(observed).toHaveLength(2);
        for (const observation of observed) {
          expect(observation).toMatchObject({
            inTransaction: false,
            entry: {
              participants: ["a", "b"].map((id) => ({ identity: profile(id) })),
              participantCount: 2,
            },
          });
        }
        expect(listSessionParticipantsReadOnly(scope).get(scope.sessionKey)).toEqual([
          { identity: profile("a"), contributionCount: 2, firstPromptedAt: 10, lastPromptedAt: 30 },
          { identity: profile("b"), contributionCount: 1, firstPromptedAt: 40, lastPromptedAt: 40 },
        ]);
      } finally {
        unsubscribe();
      }
    });
  });

  it.each(["outer", "nested"])(
    "retains committed participants after an %s transaction rollback",
    async (kind) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const scope = { agentId: "main", env: state.env, sessionKey: "agent:main:rollback" };
        await upsertSessionEntryCore(scope, { sessionId: "rollback", updatedAt: 1 });
        recordSessionParticipant(scope, { identity: profile("a"), promptedAt: 10 });
        const read = () => listSessionEntriesCore({ ...scope, projection: "list" });
        const before = read();
        const attempt = () =>
          runOpenClawAgentWriteTransaction(() => {
            recordSessionParticipant(scope, { identity: profile("b"), promptedAt: 20 });
            throw new Error("rollback participant");
          }, scope);
        if (kind === "nested") {
          runOpenClawAgentWriteTransaction(() => {
            expect(attempt).toThrow("rollback participant");
          }, scope);
        } else {
          expect(attempt).toThrow("rollback participant");
        }
        expect(read()).toEqual(before);
        expect(listSessionParticipantsReadOnly(scope).get(scope.sessionKey)).toHaveLength(1);
      });
    },
  );

  it.each(["participant", "owner"] as const)(
    "keeps cache projection errors from rolling back a recorded %s",
    async (mutation) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const scope = {
          agentId: "main",
          env: state.env,
          sessionKey: "agent:main:projection-error",
        };
        await upsertSessionEntryCore(scope, { sessionId: "projection-error", updatedAt: 1 });
        recordSessionParticipant(scope, { identity: profile("a"), promptedAt: 10 });
        listSessionEntriesCore({ ...scope, projection: "list" });
        const database = openOpenClawAgentDatabase(scope);
        database.db
          .prepare("UPDATE session_participants SET identity_namespace = ?")
          .run('{"type":"profile","extra":true}');
        if (mutation === "participant") {
          expect(recordSessionParticipant(scope, { identity: profile("b"), promptedAt: 20 })).toBe(
            "inserted",
          );
        } else {
          expect(
            assignSessionOwner(scope, {
              owner: { type: "agent", id: "assigned" },
              assignedBy: { type: "agent", id: "main" },
              assignedAt: 20,
            }),
          ).toMatchObject({ actor: { type: "agent", id: "assigned" } });
          expect(
            database.db
              .prepare("SELECT owner_actor_id FROM session_nodes WHERE session_key = ?")
              .get(scope.sessionKey)?.owner_actor_id,
          ).toBe("assigned");
        }
        expect(() => listSessionEntriesCore({ ...scope, projection: "list" })).toThrow(
          "Session participant identity is invalid",
        );
        expect(
          database.db.prepare("SELECT count(*) AS count FROM session_participants").get()?.count,
        ).toBe(mutation === "participant" ? 2 : 1);
      });
    },
  );

  it.each([false, true])(
    "refreshes participant order without reloading sibling metadata (selected: %s)",
    async (selected) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const scope = { agentId: "main", env: state.env };
        const sessionKey = "agent:main:target";
        const database = openOpenClawAgentDatabase(scope);
        runOpenClawAgentWriteTransaction((db) => {
          for (let index = 0; index < 32; index++) {
            writeSessionEntry(db, `agent:main:sibling-${index}`, {
              sessionId: `sibling-${index}`,
              updatedAt: 1,
              skillsSnapshot: { prompt: "saved sibling prompt".repeat(1024), skills: [] },
            });
          }
          writeSessionEntry(db, sessionKey, { sessionId: "target", updatedAt: 1 });
        }, scope);
        recordSessionParticipant(
          { ...scope, sessionKey },
          { identity: profile("a"), promptedAt: 10 },
        );
        recordSessionParticipant(
          { ...scope, sessionKey },
          { identity: profile("b"), promptedAt: 20 },
        );
        const read = () =>
          listSessionEntriesCore({
            ...scope,
            projection: "list",
            ...(selected ? { sessionKeys: [sessionKey] } : {}),
          });
        read();
        const executions = trackSqliteStatementExecutions(database.db, ["metadata"], (sql) =>
          sql.includes('from "session_nodes"') && sql.includes("entry_json") ? "metadata" : null,
        );
        try {
          for (const [identity, promptedAt, order] of [
            ["c", 30, ["a", "b", "c"]],
            ["a", 40, ["a", "b", "c"]],
            ["b", 5, ["b", "a", "c"]],
          ] as const) {
            recordSessionParticipant(
              { ...scope, sessionKey },
              { identity: profile(identity), promptedAt },
            );
            const entry = read().find((row) => row.sessionKey === sessionKey)?.entry;
            expect(entry?.participants).toEqual(order.map((id) => ({ identity: profile(id) })));
            expect(entry?.participantCount).toBe(3);
          }
          expect(executions.rowCounts.metadata).toBeLessThanOrEqual(3);
        } finally {
          executions.restore();
        }
      });
    },
  );

  it("isolates an invalid participant identity to its requested session", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const scope = { agentId: "main", env: state.env };
      const keys = ["agent:main:before", "agent:main:invalid", "agent:main:after"] as const;
      for (const [index, sessionKey] of keys.entries()) {
        await upsertSessionEntryCore(
          { ...scope, sessionKey },
          { sessionId: `session-${index}`, updatedAt: index + 1 },
        );
        recordSessionParticipant(
          { ...scope, sessionKey },
          { identity: profile(`person-${index}`), promptedAt: index + 1 },
        );
      }
      const read = (sessionKeys: readonly string[], projection: "full" | "list") =>
        loadExactSessionEntryCandidatesReadOnlyBatch(
          sessionKeys.map((sessionKey) => ({ ...scope, sessionKeys: [sessionKey], projection })),
        );
      expect(read(keys, "list").every((result) => result.ok)).toBe(true);
      const database = openOpenClawAgentDatabase(scope);
      // Model a damaged saved namespace without changing the session row or schema.
      database.db
        .prepare("UPDATE session_participants SET identity_namespace = ? WHERE session_key = ?")
        .run('{"type":"profile","extra":true}', keys[1]);
      const expectedEntry = (index: 0 | 1 | 2) => ({
        ok: true,
        value: [
          {
            sessionKey: keys[index],
            entry: {
              participants: [{ identity: profile(`person-${index}`) }],
              participantCount: 1,
            },
          },
        ],
      });
      for (const projection of ["full", "list"] as const) {
        expect(read([keys[0], keys[1], "agent:main:missing", keys[2]], projection)).toMatchObject([
          expectedEntry(0),
          {
            ok: false,
            error: expect.objectContaining({
              message: "Session participant identity is invalid; run openclaw doctor --fix.",
            }),
          },
          { ok: true, value: [] },
          expectedEntry(2),
        ]);
        expect(read([keys[0], keys[2]], projection)).toMatchObject([
          expectedEntry(0),
          expectedEntry(2),
        ]);
      }
    });
  });

  it("does not create a missing agent database during participant reads", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      expect(listSessionParticipantsReadOnly({ agentId: "absent", env: state.env }).size).toBe(0);
      expect(existsSync(state.agentDir("absent"))).toBe(false);
    });
  });

  it.each([false, true])(
    "keeps namespaces and times separate (profile first: %s)",
    async (profileFirst) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const scope = { agentId: "main", env: state.env, sessionKey: "agent:main:collision" };
        await upsertSessionEntryCore(scope, { sessionId: "collision", updatedAt: 1 });
        const inputs = [
          { identity: remote("same-id"), promptedAt: 10 },
          { identity: remote("same-id"), promptedAt: 20 },
          { identity: profile("same-id"), promptedAt: 30 },
          { identity: profile("same-id"), promptedAt: 40 },
          { identity: remote("same-id"), promptedAt: 50 },
          { identity: remote("same-id"), promptedAt: 5 },
        ];
        for (const input of profileFirst ? inputs.toReversed() : inputs) {
          recordSessionParticipant(scope, input);
        }
        recordSessionParticipant(scope, {
          identity: { type: "agent", id: "same-id" },
          promptedAt: 40,
        });
        recordSessionParticipant(scope, {
          identity: remote("same-id", "other-workspace"),
          promptedAt: 40,
        });
        closeOpenClawAgentDatabasesForTest();
        const records = listSessionParticipantsReadOnly(scope).get(scope.sessionKey) ?? [];
        expect(records).toHaveLength(4);
        expect(records).toEqual(
          expect.arrayContaining([
            {
              identity: profile("same-id"),
              contributionCount: 2,
              firstPromptedAt: 30,
              lastPromptedAt: 40,
            },
            {
              identity: remote("same-id"),
              contributionCount: 4,
              firstPromptedAt: 5,
              lastPromptedAt: 50,
            },
            {
              identity: remote("same-id", "other-workspace"),
              contributionCount: 1,
              firstPromptedAt: 40,
              lastPromptedAt: 40,
            },
            {
              identity: { type: "agent", id: "same-id" },
              contributionCount: 1,
              firstPromptedAt: 40,
              lastPromptedAt: 40,
            },
          ]),
        );
      });
    },
  );

  it.each([false, true])(
    "updates a merged profile at the admission bound (canonical row: %s)",
    async (hasCanonicalRow) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const scope = { agentId: "main", env: state.env, sessionKey: "agent:main:merged-full" };
        const old = ensureProfileForEmail("old@example.test", { env: state.env });
        const other = ensureProfileForEmail("other@example.test", { env: state.env });
        const current = ensureProfileForEmail("current@example.test", { env: state.env });
        await upsertSessionEntryCore(scope, { sessionId: "merged-full", updatedAt: 1 });
        recordSessionParticipant(scope, { identity: profile(old.id), promptedAt: 10 });
        recordSessionParticipant(scope, { identity: profile(other.id), promptedAt: 10 });
        if (hasCanonicalRow) {
          recordSessionParticipant(scope, { identity: profile(current.id), promptedAt: 20 });
        }
        for (let index = hasCanonicalRow ? 3 : 2; index < MAX_SESSION_PARTICIPANTS; index++) {
          recordSessionParticipant(scope, { identity: remote(`remote-${index}`), promptedAt: 30 });
        }
        linkEmail("old@example.test", current.id, { env: state.env });
        linkEmail("other@example.test", current.id, { env: state.env });
        expect(
          recordSessionParticipant(scope, { identity: profile(current.id), promptedAt: 40 }),
        ).toBe("updated");
        const records = listSessionParticipantsReadOnly(scope).get(scope.sessionKey) ?? [];
        expect(records).toHaveLength(MAX_SESSION_PARTICIPANTS);
        const profiles = records.filter((record) => record.identity.type === "profile");
        expect(profiles.reduce((count, record) => count + record.contributionCount, 0)).toBe(
          hasCanonicalRow ? 4 : 3,
        );
        const updatedId = hasCanonicalRow ? current.id : [old.id, other.id].toSorted()[0];
        expect(profiles.find((record) => record.identity.id === updatedId)).toMatchObject({
          contributionCount: 2,
          lastPromptedAt: 40,
        });
      });
    },
  );

  it("keeps raw actor identity equality when SQLite replaces a lone surrogate", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const scope = { agentId: "main", env: state.env, sessionKey: "agent:main:raw-identity" };
      await upsertSessionEntryCore(scope, { sessionId: "raw-identity", updatedAt: 1 });
      recordSessionParticipant(scope, { identity: remote("\ud800"), promptedAt: 10 });
      for (let index = 1; index < MAX_SESSION_PARTICIPANTS; index++) {
        recordSessionParticipant(scope, { identity: remote(`remote-${index}`), promptedAt: 10 });
      }
      expect(recordSessionParticipant(scope, { identity: remote("\ud800"), promptedAt: 20 })).toBe(
        "capped",
      );
      expect(listSessionParticipantsReadOnly(scope).get(scope.sessionKey)).toContainEqual({
        identity: remote("\ufffd"),
        contributionCount: 1,
        firstPromptedAt: 10,
        lastPromptedAt: 10,
      });
    });
  });

  it("keeps the admission bound, unknown first time, reset history, and deletion ownership", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const scope = { agentId: "main", env: state.env, sessionKey: "agent:main:bounded" };
      await upsertSessionEntryCore(scope, { sessionId: "bounded", updatedAt: 1 });
      const database = openOpenClawAgentDatabase({ agentId: "main", env: state.env });
      expect(loadSessionEntry(scope)).toMatchObject({ sessionId: "bounded" });
      database.db.exec("DROP TABLE session_participants");
      expect(loadSessionEntry(scope)).toMatchObject({ sessionId: "bounded" });
      expect(listSessionParticipantsReadOnly(scope).get(scope.sessionKey)).toBeUndefined();
      expect(
        database.db
          .prepare("SELECT name FROM sqlite_schema WHERE name = 'session_participants'")
          .get(),
      ).toBeUndefined();
      for (let index = 0; index < MAX_SESSION_PARTICIPANTS; index++) {
        expect(
          recordSessionParticipant(scope, {
            identity: profile(`profile-${index}`),
            promptedAt: 10,
          }),
        ).toBe("inserted");
      }
      expect(
        recordSessionParticipant(scope, { identity: remote("profile-0"), promptedAt: 10 }),
      ).toBe("capped");
      expect(
        recordSessionParticipant(scope, {
          identity: { type: "agent", id: "main" },
          sessionAgentId: "main",
        }),
      ).toBeNull();
      database.db
        .prepare(
          "UPDATE session_participants SET first_prompted_at = NULL, last_prompted_at = NULL WHERE actor_id = 'profile-0'",
        )
        .run();
      recordSessionParticipant(scope, { identity: profile("profile-0"), promptedAt: 20 });
      recordSessionParticipant(scope, { identity: profile("profile-0"), promptedAt: 20 });
      recordSessionParticipant(scope, { identity: profile("profile-0"), promptedAt: 15 });
      expect(listSessionParticipantsReadOnly(scope).get(scope.sessionKey)).toContainEqual({
        identity: profile("profile-0"),
        contributionCount: 4,
        firstPromptedAt: null,
        lastPromptedAt: 20,
      });
      await upsertSessionEntryCore(scope, { sessionId: "bounded-reset", updatedAt: 30 });
      expect(loadSessionEntry(scope)?.participants).toHaveLength(MAX_SESSION_PARTICIPANTS);
      await deleteSessionEntryLifecycle({
        agentId: "main",
        storePath: database.path,
        target: { canonicalKey: scope.sessionKey, storeKeys: [scope.sessionKey] },
        archiveTranscript: false,
      });
      expect(listSessionParticipantsReadOnly(scope).get(scope.sessionKey)).toBeUndefined();
    });
  });

  it("preserves over-bound repair histories and does not inflate retried cross-store copies", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const sourceScope = { agentId: "source", env: state.env, sessionKey: "agent:source:shared" };
      const targetScope = { agentId: "main", env: state.env, sessionKey: "agent:main:shared" };
      await upsertSessionEntryCore(sourceScope, { sessionId: "source", updatedAt: 1 });
      await upsertSessionEntryCore(targetScope, { sessionId: "target", updatedAt: 1 });
      for (let index = 0; index < MAX_SESSION_PARTICIPANTS; index++) {
        recordSessionParticipant(sourceScope, {
          identity: profile(`profile-${index}`),
          promptedAt: 10,
        });
        recordSessionParticipant(targetScope, {
          identity: remote(`profile-${index}`),
          promptedAt: 20,
        });
      }
      recordSessionParticipant(sourceScope, { identity: profile("profile-0"), promptedAt: 30 });
      const source = openOpenClawAgentDatabase({ agentId: "source", env: state.env });
      const target = openOpenClawAgentDatabase({ agentId: "main", env: state.env });
      copySessionNodeArtifactsForRepair(
        source,
        target,
        [sourceScope.sessionKey],
        targetScope.sessionKey,
      );
      copySessionNodeArtifactsForRepair(
        source,
        target,
        [sourceScope.sessionKey],
        targetScope.sessionKey,
      );
      const rows = listSessionParticipantsReadOnly(targetScope).get(targetScope.sessionKey) ?? [];
      expect(rows).toHaveLength(64);
      expect(
        rows.find((row) => row.identity.type === "profile" && row.identity.id === "profile-0")
          ?.contributionCount,
      ).toBe(2);
      const reads = trackSqliteStatementExecutions(target.db, ["participants"], (sql) =>
        sql.includes('from "session_participants"') ? "participants" : null,
      );
      try {
        expect(
          recordSessionParticipant(targetScope, {
            identity: profile("profile-0"),
            promptedAt: 40,
          }),
        ).toBe("updated");
        expect(reads.rowCounts.participants).toBeLessThanOrEqual(1);
      } finally {
        reads.restore();
      }
      expect(
        recordSessionParticipant(targetScope, { identity: profile("overflow"), promptedAt: 40 }),
      ).toBe("capped");
    });
  });
});
