import { existsSync } from "node:fs";
import { StatementSync, type DatabaseSync } from "node:sqlite";
import { MessageChannel } from "node:worker_threads";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  observeSqliteReadSql,
  trackSqliteStatementExecutions,
} from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { openNodeSqliteDatabase } from "../../infra/node-sqlite.js";
import { withSqliteWorkerOperationAdmission } from "../../infra/sqlite-worker-operation-admission.js";
import { onSessionLifecycleEvent } from "../../sessions/session-lifecycle-events.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
  deferOpenClawAgentPostCommitPublication,
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { prepareUserProfileCatalog } from "../../state/user-profile-list.js";
import { linkEmail } from "../../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { requireNativeSqliteDatabase } from "../../test-utils/native-sqlite.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { captureRuntimeConfigAsyncReader } from "../io.js";
import {
  assignSessionOwner,
  deleteSessionEntryLifecycle,
  listSessionParticipantsReadOnly,
  listSessionEntriesCore,
  loadSessionEntry,
  MAX_SESSION_PARTICIPANTS,
  patchSessionEntryCore,
  upsertSessionEntryCore,
} from "./session-accessor.js";
import { readPreparedSessionEntryChange } from "./session-accessor.sqlite-entry-cache-publication.js";
import { writeSessionEntry } from "./session-accessor.sqlite-entry-store.js";
import { copySessionNodeArtifactsForRepair } from "./session-accessor.sqlite-node-artifacts.js";
import { recordSessionParticipant } from "./session-accessor.sqlite-participants.native.js";
import type { SessionParticipantIdentity } from "./session-participant-identity.js";
import { bindSqliteWorkerBackend } from "./session-sharing-store.worker.js";

const profile = (id: string): SessionParticipantIdentity => ({ type: "profile", id });
const remote = (id: string, domain = "workspace"): SessionParticipantIdentity => ({
  type: "remote",
  pluginId: "test-channel",
  domain,
  idKind: "user",
  id,
});

async function withParticipantState(run: (state: OpenClawTestState) => Promise<void>) {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    await captureRuntimeConfigAsyncReader()();
    await run(state);
  });
}

async function seedSession(state: OpenClawTestState, name: string) {
  const scope = { agentId: "main", env: state.env, sessionKey: `agent:main:${name}` };
  await upsertSessionEntryCore(scope, { sessionId: name, updatedAt: 1 });
  return scope;
}

const recordParticipant = (
  scope: Parameters<typeof recordSessionParticipant>[0],
  identity: SessionParticipantIdentity,
  promptedAt: number,
) => recordSessionParticipant(scope, { identity, promptedAt });

const participant = (
  identity: SessionParticipantIdentity,
  contributionCount: number,
  firstPromptedAt: number | null,
  lastPromptedAt = firstPromptedAt,
) => ({ identity, contributionCount, firstPromptedAt, lastPromptedAt });

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  vi.useRealTimers();
});

describe("SQLite session participants", () => {
  it.each(["local", "foreign"])(
    "publishes fresh participants after an untracked %s write during patch preparation",
    async (writer) => {
      await withParticipantState(async (state) => {
        const scope = await seedSession(state, "changed");
        recordParticipant(scope, remote("before"), 1);
        listSessionEntriesCore({ ...scope, projection: "list" });
        const database = openOpenClawAgentDatabase(scope);
        let published: ReturnType<typeof readPreparedSessionEntryChange>;
        const unsubscribe = sessionChanges.subscribeProjection((change) => {
          if ("sessionKey" in change && change.sessionKey === scope.sessionKey) {
            published = readPreparedSessionEntryChange(change, scope.sessionKey);
          }
        });
        try {
          await patchSessionEntryCore(
            scope,
            () => {
              const connection =
                writer === "foreign" ? openNodeSqliteDatabase(database.path) : database.db;
              try {
                connection
                  .prepare("UPDATE session_participants SET actor_id = ? WHERE session_key = ?")
                  .run("after", scope.sessionKey);
              } finally {
                if (writer === "foreign") {
                  connection.close();
                }
              }
              return { label: "committed" };
            },
            { skipMaintenance: true },
          );
          const expected = {
            label: "committed",
            participants: [{ identity: remote("after") }],
            participantCount: 1,
          };
          expect(published?.entry).toMatchObject(expected);
          expect(loadSessionEntry(scope)).toMatchObject(expected);
        } finally {
          unsubscribe();
        }
      });
    },
  );

  it("reuses current participant facts when publishing repeated entry patches", async () => {
    await withParticipantState(async (state) => {
      const scope = await seedSession(state, "busy");
      recordParticipant(scope, remote("existing"), 1);
      const read = () => listSessionEntriesCore({ ...scope, projection: "list" })[0]?.entry;
      read();
      const database = openOpenClawAgentDatabase(scope);
      const reads = trackSqliteStatementExecutions(
        requireNativeSqliteDatabase(database.db),
        ["participants"],
        (sql) =>
          sql.startsWith('select "session_key", "identity_namespace", "actor_id"')
            ? "participants"
            : null,
      );
      try {
        for (let index = 0; index < 100; index++) {
          await patchSessionEntryCore(scope, () => ({ label: `Update ${index}` }), {
            skipMaintenance: true,
          });
        }
        // Metadata-only updates retain the participant owner's current revision.
        expect(reads.counts.participants).toBe(0);
        recordParticipant(scope, remote("new"), 2);
        expect(reads.counts.participants).toBe(1);
        expect(read()).toMatchObject({
          label: "Update 99",
          participants: ["existing", "new"].map((id) => ({ identity: remote(id) })),
          participantCount: 2,
        });
      } finally {
        reads.restore();
      }
    });
  });

  it.each(["participant", "external-entry"] as const)(
    "keeps a reentrant observer's newer cached state after an outer %s write",
    async (kind) => {
      await withParticipantState(async (state) => {
        if (kind === "external-entry") {
          vi.useFakeTimers({ toFake: ["setImmediate"] });
        }
        const scope = { agentId: "main", env: state.env, sessionKey: "agent:main:reentrant" };
        await upsertSessionEntryCore(scope, {
          sessionId: "reentrant",
          updatedAt: 1,
          label: "a",
        });
        recordParticipant(scope, profile("a"), 10);
        const read = () =>
          listSessionEntriesCore({ ...scope, projection: "list" }).find(
            (row) => row.sessionKey === scope.sessionKey,
          )?.entry;
        read();
        const write = (label: string, time: number, external = false) => {
          if (kind === "participant") {
            recordParticipant(scope, profile(label), time);
          } else if (external) {
            const database = openNodeSqliteDatabase(openOpenClawAgentDatabase(scope).path);
            try {
              database
                .prepare(
                  "UPDATE session_nodes SET entry_json = json_set(entry_json, '$.label', ?, '$.updatedAt', ?), updated_at = ? WHERE session_key = ?",
                )
                .run(label, time, time, scope.sessionKey);
            } finally {
              database.close();
            }
            vi.runOnlyPendingTimers();
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
    await withParticipantState(async (state) => {
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
          recordParticipant(target, profile("a"), 10);
          throw new Error("rollback schema");
        }, scope),
      ).toThrow("rollback schema");
      // Retry before a cache read can observe the rolled-back schema version.
      recordParticipant(target, profile("a"), 10);
      recordParticipant(sibling, profile("a"), 10);
      database.db
        .prepare("UPDATE session_participants SET identity_namespace = ? WHERE session_key = ?")
        .run('{"type":"profile","extra":true}', sibling.sessionKey);
      recordParticipant(target, profile("b"), 20);
      expect(read).toThrow("Session participant identity is invalid");
    });
  });

  it.each([
    { mutation: "participant-before", write: "inserted-target" },
    { mutation: "participant-after", write: "stable-repeat-target" },
    { mutation: "external-participant", write: "inserted-target" },
    { mutation: "session-before", write: "stable-repeat-target" },
  ])(
    "does not hide an untracked sibling change during participant publication: $mutation, $write",
    async ({ mutation, write }) => {
      await withParticipantState(async (state) => {
        if (mutation === "external-participant") {
          vi.useFakeTimers({ toFake: ["setImmediate"] });
        }
        const scope = { agentId: "main", env: state.env };
        const target = { ...scope, sessionKey: "agent:main:target" };
        const sibling = { ...scope, sessionKey: "agent:main:sibling" };
        for (const entryScope of [target, sibling]) {
          await upsertSessionEntryCore(entryScope, {
            sessionId: entryScope.sessionKey,
            updatedAt: 1,
          });
          recordParticipant(entryScope, profile("a"), 10);
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
          const external = openNodeSqliteDatabase(database.path);
          try {
            mutate(external);
          } finally {
            external.close();
          }
          vi.runOnlyPendingTimers();
        }
        runOpenClawAgentWriteTransaction((db) => {
          if (mutation.endsWith("before")) {
            mutate(requireNativeSqliteDatabase(db.db));
          }
          recordParticipant(target, profile(write === "inserted-target" ? "b" : "a"), 20);
          if (mutation === "participant-after") {
            mutate(requireNativeSqliteDatabase(db.db));
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

  it("refuses a participant insert inside a raw transaction without changing its rows", async () => {
    await withParticipantState(async (state) => {
      const scope = await seedSession(state, "raw-transaction");
      recordParticipant(scope, profile("a"), 10);
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
        expect(() => recordParticipant(scope, profile("b"), 20)).toThrow(
          "must use runOpenClawAgentWriteTransaction",
        );
        expect(rows.all()).toEqual(rowsBefore);
      } finally {
        database.db.exec("ROLLBACK");
      }
      expect(read()).toEqual(before);
      expect(listSessionParticipantsReadOnly(scope).get(scope.sessionKey)).toEqual(
        participantsBefore,
      );
    });
  });

  it("publishes the final participant view only after the outer transaction commits", async () => {
    await withParticipantState(async (state) => {
      const scope = await seedSession(state, "participant-events");
      recordParticipant(scope, profile("a"), 10);
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
            recordParticipant(scope, profile("a"), 20);
            expect(observed).toEqual([]);
            throw new Error("rollback participant");
          }, scope),
        ).toThrow("rollback participant");
        expect(observed).toEqual([]);
        runOpenClawAgentWriteTransaction(() => {
          recordParticipant(scope, profile("a"), 30);
          runOpenClawAgentWriteTransaction(() => {
            recordParticipant(scope, profile("b"), 40);
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
          participant(profile("a"), 2, 10, 30),
          participant(profile("b"), 1, 40),
        ]);
      } finally {
        unsubscribe();
      }
    });
  });

  it("retains committed participants after a nested transaction rollback", async () => {
    await withParticipantState(async (state) => {
      const scope = await seedSession(state, "rollback");
      recordParticipant(scope, profile("a"), 10);
      const read = () => listSessionEntriesCore({ ...scope, projection: "list" });
      const before = read();
      const attempt = () =>
        runOpenClawAgentWriteTransaction(() => {
          recordParticipant(scope, profile("b"), 20);
          throw new Error("rollback participant");
        }, scope);
      runOpenClawAgentWriteTransaction(() => {
        expect(attempt).toThrow("rollback participant");
      }, scope);
      expect(read()).toEqual(before);
      expect(listSessionParticipantsReadOnly(scope).get(scope.sessionKey)).toHaveLength(1);
    });
  });

  it.each(["participant", "owner"] as const)(
    "keeps cache projection errors from rolling back a recorded %s",
    async (mutation) => {
      await withParticipantState(async (state) => {
        const scope = await seedSession(state, "projection-error");
        recordParticipant(scope, profile("a"), 10);
        listSessionEntriesCore({ ...scope, projection: "list" });
        const database = openOpenClawAgentDatabase(scope);
        database.db
          .prepare("UPDATE session_participants SET identity_namespace = ?")
          .run('{"type":"profile","extra":true}');
        if (mutation === "participant") {
          expect(recordParticipant(scope, profile("b"), 20)).toBe("inserted");
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
      await withParticipantState(async (state) => {
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
        recordParticipant({ ...scope, sessionKey }, profile("a"), 10);
        recordParticipant({ ...scope, sessionKey }, profile("b"), 20);
        const read = () =>
          listSessionEntriesCore({
            ...scope,
            projection: "list",
            ...(selected ? { sessionKeys: [sessionKey] } : {}),
          });
        read();
        const executions = trackSqliteStatementExecutions(
          requireNativeSqliteDatabase(database.db),
          ["metadata"],
          (sql) =>
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

  it("does not create a missing agent database during participant reads", async () => {
    await withParticipantState(async (state) => {
      expect(listSessionParticipantsReadOnly({ agentId: "absent", env: state.env }).size).toBe(0);
      expect(existsSync(state.agentDir("absent"))).toBe(false);
    });
  });

  it("keeps namespaces and times separate", async () => {
    await withParticipantState(async (state) => {
      const scope = await seedSession(state, "collision");
      const inputs = [
        { identity: remote("same-id"), promptedAt: 10 },
        { identity: remote("same-id"), promptedAt: 20 },
        { identity: profile("same-id"), promptedAt: 30 },
        { identity: profile("same-id"), promptedAt: 40 },
        { identity: remote("same-id"), promptedAt: 50 },
        { identity: remote("same-id"), promptedAt: 5 },
      ];
      for (const input of inputs) {
        recordSessionParticipant(scope, input);
      }
      recordSessionParticipant(scope, {
        identity: { type: "agent", id: "same-id" },
        promptedAt: 40,
      });
      recordParticipant(scope, remote("same-id", "other-workspace"), 40);
      await closeOpenClawAgentDatabasesAsync();
      closeOpenClawAgentDatabasesForTest();
      const records = listSessionParticipantsReadOnly(scope).get(scope.sessionKey) ?? [];
      expect(records).toHaveLength(4);
      expect(records).toEqual(
        expect.arrayContaining([
          participant(profile("same-id"), 2, 30, 40),
          participant(remote("same-id"), 4, 5, 50),
          participant(remote("same-id", "other-workspace"), 1, 40),
          participant({ type: "agent", id: "same-id" }, 1, 40),
        ]),
      );
    });
  });

  it("keeps count-only worker contributions out of the participant projection and publishes reordered facts", async () => {
    await withParticipantState(async (state) => {
      const scope = await seedSession(state, "worker-counts");
      recordParticipant(scope, remote("first"), 10);
      recordParticipant(scope, remote("second"), 20);
      listSessionParticipantsReadOnly(scope);
      listSessionEntriesCore({ ...scope, projection: "list" });
      const database = openOpenClawAgentDatabase(scope);
      const backend = bindSqliteWorkerBackend(undefined, {
        database: database.db,
        databasePath: database.path,
        admit() {},
      });
      const { port1, port2 } = new MessageChannel();
      const record = (promptedAt: number) =>
        withSqliteWorkerOperationAdmission({ port: port1 }, () =>
          backend.execute({
            type: "participant",
            input: { scope, params: { identity: remote("second"), promptedAt } },
          }),
        );
      const reads = trackSqliteStatementExecutions(
        requireNativeSqliteDatabase(database.db),
        ["projection"],
        (sql) =>
          sql.startsWith('select "session_key", "identity_namespace", "actor_id"')
            ? "projection"
            : null,
      );
      try {
        expect(record(30)).toEqual({
          value: "updated",
          projectionChanged: false,
          participants: {},
        });
        expect(reads.counts.projection).toBe(0);
        expect(listSessionParticipantsReadOnly(scope).get(scope.sessionKey)).toEqual([
          participant(remote("first"), 1, 10),
          participant(remote("second"), 2, 20, 30),
        ]);
        const participants = ["second", "first"].map((id) => ({ identity: remote(id) }));
        expect(record(5)).toEqual({
          value: "updated",
          projectionChanged: true,
          participants: { participants, participantCount: 2 },
        });
        expect(loadSessionEntry(scope)).toMatchObject({ participants, participantCount: 2 });
        expect(listSessionParticipantsReadOnly(scope).get(scope.sessionKey)?.[0]).toEqual(
          participant(remote("second"), 3, 5, 30),
        );
        backend.assertSettled?.();
      } finally {
        reads.restore();
        port1.close();
        port2.close();
        await backend.close();
      }
    });
  });

  it.each([false, true])(
    "updates a merged profile at the admission bound using resident native aliases (canonical row: %s)",
    async (hasCanonicalRow) => {
      await withParticipantState(async (state) => {
        const scope = { agentId: "main", env: state.env, sessionKey: "agent:main:merged-full" };
        const old = ensureProfileForEmail("old@example.test", { env: state.env });
        const other = ensureProfileForEmail("other@example.test", { env: state.env });
        const current = ensureProfileForEmail("current@example.test", { env: state.env });
        using _ = {
          [Symbol.dispose]: (await prepareUserProfileCatalog({ env: state.env })).release,
        };
        await upsertSessionEntryCore(scope, { sessionId: "merged-full", updatedAt: 1 });
        recordParticipant(scope, profile(old.id), 10);
        recordParticipant(scope, profile(other.id), 10);
        if (hasCanonicalRow) {
          recordParticipant(scope, profile(current.id), 20);
        }
        for (let index = hasCanonicalRow ? 3 : 2; index < MAX_SESSION_PARTICIPANTS; index++) {
          recordParticipant(scope, remote(`remote-${index}`), 30);
        }
        linkEmail("old@example.test", current.id, { env: state.env });
        linkEmail("other@example.test", current.id, { env: state.env });
        const database = openOpenClawAgentDatabase(scope);
        const backend = bindSqliteWorkerBackend(undefined, {
          database: database.db,
          databasePath: database.path,
          admit() {},
        });
        const { port1, port2 } = new MessageChannel();
        try {
          const params = { identity: profile(current.id), promptedAt: 40 };
          for (const writer of ["native", "worker"] as const) {
            const profileReads = observeSqliteReadSql(StatementSync.prototype);
            const transactionSql = vi.spyOn(database.db, "exec");
            try {
              if (writer === "native") {
                expect(recordSessionParticipant(scope, params)).toBe("updated");
              } else {
                expect(
                  withSqliteWorkerOperationAdmission({ port: port1 }, () =>
                    backend.execute({ type: "participant", input: { scope, params } }),
                  ),
                ).toMatchObject({
                  value: "updated",
                });
              }
              const aliases = profileReads.queries.filter((sql) =>
                sql.includes('from "user_profiles"'),
              );
              if (writer === "native" || hasCanonicalRow) {
                expect(aliases).toHaveLength(0);
              } else {
                expect(aliases.length).toBeGreaterThan(0);
              }
              if (writer === "worker") {
                expect(transactionSql.mock.calls.some(([sql]) => /SAVEPOINT/i.test(sql))).toBe(
                  false,
                );
              }
            } finally {
              transactionSql.mockRestore();
              profileReads.restore();
            }
          }
          backend.assertSettled?.();
        } finally {
          port1.close();
          port2.close();
          await backend.close();
        }
        const records = listSessionParticipantsReadOnly(scope).get(scope.sessionKey) ?? [];
        expect(records).toHaveLength(MAX_SESSION_PARTICIPANTS);
        const profiles = records.filter((record) => record.identity.type === "profile");
        expect(profiles.reduce((count, record) => count + record.contributionCount, 0)).toBe(
          hasCanonicalRow ? 5 : 4,
        );
        const updatedId = hasCanonicalRow ? current.id : [old.id, other.id].toSorted()[0];
        expect(profiles.find((record) => record.identity.id === updatedId)).toMatchObject({
          contributionCount: 3,
          lastPromptedAt: 40,
        });
      });
    },
  );

  it("keeps raw actor identity equality when SQLite replaces a lone surrogate", async () => {
    await withParticipantState(async (state) => {
      const scope = await seedSession(state, "raw-identity");
      recordParticipant(scope, remote("\ud800"), 10);
      for (let index = 1; index < MAX_SESSION_PARTICIPANTS; index++) {
        recordParticipant(scope, remote(`remote-${index}`), 10);
      }
      expect(recordParticipant(scope, remote("\ud800"), 20)).toBe("capped");
      expect(listSessionParticipantsReadOnly(scope).get(scope.sessionKey)).toContainEqual(
        participant(remote("\ufffd"), 1, 10),
      );
    });
  });

  it("keeps the admission bound, unknown first time, reset history, and deletion ownership", async () => {
    await withParticipantState(async (state) => {
      const scope = await seedSession(state, "bounded");
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
        expect(recordParticipant(scope, profile(`profile-${index}`), 10)).toBe("inserted");
      }
      expect(recordParticipant(scope, remote("profile-0"), 10)).toBe("capped");
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
      recordParticipant(scope, profile("profile-0"), 20);
      recordParticipant(scope, profile("profile-0"), 20);
      recordParticipant(scope, profile("profile-0"), 15);
      expect(listSessionParticipantsReadOnly(scope).get(scope.sessionKey)).toContainEqual(
        participant(profile("profile-0"), 4, null, 20),
      );
      await upsertSessionEntryCore(scope, { sessionId: "bounded-reset", updatedAt: 30 });
      expect(loadSessionEntry(scope)?.participants).toHaveLength(MAX_SESSION_PARTICIPANTS);
      const deletion = await deleteSessionEntryLifecycle({
        agentId: "main",
        storePath: database.path,
        target: { canonicalKey: scope.sessionKey, storeKeys: [scope.sessionKey] },
        archiveTranscript: false,
      });
      expect(deletion.deleted).toBe(true);
      expect(listSessionParticipantsReadOnly(scope).get(scope.sessionKey)).toBeUndefined();
    });
  });

  it("merges alias contributions with current destination writes and unknown timestamps", async () => {
    await withParticipantState(async (state) => {
      const makeScope = (name: string) => ({
        agentId: "main",
        env: state.env,
        sessionKey: `agent:main:${name}`,
      });
      const canonical = makeScope("canonical");
      const first = makeScope("first-alias");
      const second = makeScope("second-alias");
      for (const scope of [canonical, first, second]) {
        await upsertSessionEntryCore(scope, { sessionId: scope.sessionKey, updatedAt: 1 });
      }
      recordParticipant(canonical, profile("shared"), 20);
      recordParticipant(first, profile("shared"), 10);
      recordParticipant(first, profile("shared"), 30);
      recordParticipant(second, profile("shared"), 40);
      const database = openOpenClawAgentDatabase(canonical);
      database.db
        .prepare("UPDATE session_participants SET first_prompted_at = NULL WHERE session_key = ?")
        .run(second.sessionKey);
      const reads = trackSqliteStatementExecutions(
        requireNativeSqliteDatabase(database.db),
        ["participants"],
        (sql) => (sql.includes('from "session_participants"') ? "participants" : null),
      );
      try {
        runOpenClawAgentWriteTransaction(() => {
          copySessionNodeArtifactsForRepair(
            database,
            database,
            [canonical.sessionKey, first.sessionKey, second.sessionKey],
            canonical.sessionKey,
          );
          // A second transfer must consume the aggregate written earlier in this transaction.
          copySessionNodeArtifactsForRepair(
            database,
            database,
            [first.sessionKey],
            canonical.sessionKey,
          );
        }, canonical);
        expect(reads.counts.participants).toBe(2);
      } finally {
        reads.restore();
      }
      expect(listSessionParticipantsReadOnly(canonical).get(canonical.sessionKey)).toEqual([
        participant(profile("shared"), 6, null, 40),
      ]);
    });
  });

  it("preserves over-bound repair histories and does not inflate retried cross-store copies", async () => {
    await withParticipantState(async (state) => {
      const sourceScope = { agentId: "source", env: state.env, sessionKey: "agent:source:shared" };
      const targetScope = { agentId: "main", env: state.env, sessionKey: "agent:main:shared" };
      await upsertSessionEntryCore(sourceScope, { sessionId: "source", updatedAt: 1 });
      await upsertSessionEntryCore(targetScope, { sessionId: "target", updatedAt: 1 });
      for (let index = 0; index < MAX_SESSION_PARTICIPANTS; index++) {
        recordParticipant(sourceScope, profile(`profile-${index}`), 10);
        recordParticipant(targetScope, remote(`profile-${index}`), 20);
      }
      recordParticipant(sourceScope, profile("profile-0"), 30);
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
      const reads = trackSqliteStatementExecutions(
        requireNativeSqliteDatabase(target.db),
        ["participants"],
        (sql) => (sql.includes('from "session_participants"') ? "participants" : null),
      );
      try {
        expect(recordParticipant(targetScope, profile("profile-0"), 40)).toBe("updated");
        expect(reads.rowCounts.participants).toBeLessThanOrEqual(1);
      } finally {
        reads.restore();
      }
      expect(recordParticipant(targetScope, profile("overflow"), 40)).toBe("capped");
    });
  });
});
