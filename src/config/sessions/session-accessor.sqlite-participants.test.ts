import { existsSync } from "node:fs";
import { StatementSync, type DatabaseSync } from "node:sqlite";
import { MessageChannel } from "node:worker_threads";
import { describe, expect, it, vi } from "vitest";
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
import type { SessionAccessScope } from "./session-accessor.sqlite-contract.js";
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

let state: OpenClawTestState;
it.aroundEach(async (run) => {
  try {
    await withOpenClawTestState({ scenario: "minimal" }, async (currentState) => {
      state = currentState;
      await captureRuntimeConfigAsyncReader()();
      await run();
    });
  } finally {
    closeOpenClawAgentDatabasesForTest();
    vi.useRealTimers();
  }
});

async function makeSession(name: string) {
  const scope = { agentId: "main", env: state.env, sessionKey: `agent:main:${name}` };
  await upsertSessionEntryCore(scope, { sessionId: name, updatedAt: 1 });
  return scope;
}

const contribute = (
  scope: SessionAccessScope,
  identity: SessionParticipantIdentity,
  promptedAt: number,
) => recordSessionParticipant(scope, { identity, promptedAt });
const readParticipants = (
  scope: Parameters<typeof listSessionParticipantsReadOnly>[0] & { sessionKey: string },
) => listSessionParticipantsReadOnly(scope).get(scope.sessionKey);
const aggregate = (
  identity: SessionParticipantIdentity,
  contributionCount: number,
  firstPromptedAt: number | null,
  lastPromptedAt = firstPromptedAt,
) => ({ identity, contributionCount, firstPromptedAt, lastPromptedAt });

function trackReads<Key extends string>(
  database: ReturnType<typeof openOpenClawAgentDatabase>,
  key: Key,
  matches: (sql: string) => boolean,
) {
  const reads = trackSqliteStatementExecutions(
    requireNativeSqliteDatabase(database.db),
    [key],
    (sql) => (matches(sql) ? key : null),
  );
  return Object.assign(reads, { [Symbol.dispose]: reads.restore });
}

function participantWorker(
  database: ReturnType<typeof openOpenClawAgentDatabase>,
  scope: SessionAccessScope,
) {
  const backend = bindSqliteWorkerBackend(undefined, {
    database: database.db,
    databasePath: database.path,
    admit() {},
  });
  const { port1, port2 } = new MessageChannel();
  return {
    record: (params: Parameters<typeof recordSessionParticipant>[1]) =>
      withSqliteWorkerOperationAdmission({ port: port1 }, () =>
        backend.execute({ type: "participant", input: { scope, params } }),
      ),
    assertSettled: () => backend.assertSettled?.(),
    async [Symbol.asyncDispose]() {
      port1.close();
      port2.close();
      await backend.close();
    },
  };
}

describe("SQLite session participants", () => {
  it("measures cold participant capacity and warm contribution reads", async () => {
    const scope = await makeSession("capacity-measure");
    const database = openOpenClawAgentDatabase(scope);
    using reads = trackReads(
      database,
      "capacity",
      (sql) =>
        sql.startsWith('select count(*) as "count"') && sql.includes('"session_participants"'),
    );
    for (const [promptedAt, result] of [
      [10, "inserted"],
      [20, "updated"],
    ] as const) {
      expect(contribute(scope, remote("sender"), promptedAt)).toBe(result);
      expect(reads.counts).toEqual({ capacity: 0 });
    }
    expect(readParticipants(scope)).toEqual([aggregate(remote("sender"), 2, 10, 20)]);
  });

  it.each(["local", "foreign"])(
    "publishes fresh participants after an untracked %s write during patch preparation",
    async (writer) => {
      const scope = await makeSession("changed");
      contribute(scope, remote("before"), 1);
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
    },
  );

  it("reuses current participant facts when publishing repeated entry patches", async () => {
    const scope = await makeSession("busy");
    contribute(scope, remote("existing"), 1);
    const read = () => listSessionEntriesCore({ ...scope, projection: "list" })[0]?.entry;
    read();
    const database = openOpenClawAgentDatabase(scope);
    using reads = trackReads(database, "participants", (sql) =>
      sql.startsWith('select "session_key", "identity_namespace", "actor_id"'),
    );
    for (let index = 0; index < 100; index++) {
      await patchSessionEntryCore(scope, () => ({ label: `Update ${index}` }), {
        skipMaintenance: true,
      });
    }
    // Metadata-only updates retain the participant owner's current revision.
    expect(reads.counts.participants).toBe(0);
    contribute(scope, remote("new"), 2);
    expect(reads.counts.participants).toBe(1);
    expect(read()).toMatchObject({
      label: "Update 99",
      participants: ["existing", "new"].map((id) => ({ identity: remote(id) })),
      participantCount: 2,
    });
  });

  it.each(["participant", "external-entry"] as const)(
    "keeps a reentrant observer's newer cached state after an outer %s write",
    async (kind) => {
      if (kind === "external-entry") {
        vi.useFakeTimers({ toFake: ["setImmediate"] });
      }
      const scope = { agentId: "main", env: state.env, sessionKey: "agent:main:reentrant" };
      await upsertSessionEntryCore(scope, {
        sessionId: "reentrant",
        updatedAt: 1,
        label: "a",
      });
      contribute(scope, profile("a"), 10);
      const read = () =>
        listSessionEntriesCore({ ...scope, projection: "list" }).find(
          (row) => row.sessionKey === scope.sessionKey,
        )?.entry;
      read();
      const write = (label: string, time: number, external = false) => {
        if (kind === "participant") {
          contribute(scope, profile(label), time);
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
    },
  );

  it("reinstalls participant tracking after first-use schema rollback and immediate retry", async () => {
    const target = await makeSession("target");
    const sibling = await makeSession("sibling");
    const database = openOpenClawAgentDatabase(target);
    database.db.exec("DROP TABLE session_participants");
    const read = () => listSessionEntriesCore({ ...target, projection: "list" });
    read();
    expect(() =>
      runOpenClawAgentWriteTransaction(() => {
        contribute(target, profile("a"), 10);
        throw new Error("rollback schema");
      }, target),
    ).toThrow("rollback schema");
    // Retry before a cache read can observe the rolled-back schema version.
    contribute(target, profile("a"), 10);
    contribute(sibling, profile("a"), 10);
    database.db
      .prepare("UPDATE session_participants SET identity_namespace = ? WHERE session_key = ?")
      .run('{"type":"profile","extra":true}', sibling.sessionKey);
    contribute(target, profile("b"), 20);
    expect(read).toThrow("Session participant identity is invalid");
  });

  it.each([
    { mutation: "participant-before", write: "inserted-target" },
    { mutation: "participant-after", write: "stable-repeat-target" },
    { mutation: "external-participant", write: "inserted-target" },
    { mutation: "session-before", write: "stable-repeat-target" },
  ])(
    "does not hide an untracked sibling change during participant publication: $mutation, $write",
    async ({ mutation, write }) => {
      if (mutation === "external-participant") {
        vi.useFakeTimers({ toFake: ["setImmediate"] });
      }
      const target = await makeSession("target");
      const sibling = await makeSession("sibling");
      for (const entryScope of [target, sibling]) {
        contribute(entryScope, profile("a"), 10);
      }
      const database = openOpenClawAgentDatabase(target);
      const read = () => listSessionEntriesCore({ ...target, projection: "list" });
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
        contribute(target, profile(write === "inserted-target" ? "b" : "a"), 20);
        if (mutation === "participant-after") {
          mutate(requireNativeSqliteDatabase(db.db));
        }
      }, target);
      expect(readParticipants(target)).toHaveLength(write === "inserted-target" ? 2 : 1);
      if (mutation === "session-before") {
        expect(read().find((row) => row.sessionKey === sibling.sessionKey)?.entry.label).toBe(
          "changed",
        );
      } else {
        expect(read).toThrow("Session participant identity is invalid");
      }
    },
  );

  it("refuses a participant insert inside a raw transaction without changing its rows", async () => {
    const scope = await makeSession("raw-transaction");
    contribute(scope, profile("a"), 10);
    const read = () => listSessionEntriesCore({ ...scope, projection: "list" });
    const before = read();
    const participantsBefore = readParticipants(scope);
    const database = openOpenClawAgentDatabase(scope);
    const rows = database.db.prepare(
      "SELECT * FROM session_participants ORDER BY actor_id, identity_namespace",
    );
    const rowsBefore = rows.all();
    database.db.exec("BEGIN");
    try {
      expect(() => contribute(scope, profile("b"), 20)).toThrow(
        "must use runOpenClawAgentWriteTransaction",
      );
      expect(rows.all()).toEqual(rowsBefore);
    } finally {
      database.db.exec("ROLLBACK");
    }
    expect(read()).toEqual(before);
    expect(readParticipants(scope)).toEqual(participantsBefore);
  });

  it("publishes the final participant view only after the outer transaction commits", async () => {
    const scope = await makeSession("participant-events");
    contribute(scope, profile("a"), 10);
    const read = () =>
      listSessionEntriesCore({ ...scope, projection: "list" }).find(
        (row) => row.sessionKey === scope.sessionKey,
      )?.entry;
    const before = listSessionEntriesCore({ ...scope, projection: "list" });
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
          contribute(scope, profile("a"), 20);
          expect(observed).toEqual([]);
          throw new Error("rollback participant");
        }, scope),
      ).toThrow("rollback participant");
      expect(observed).toEqual([]);
      runOpenClawAgentWriteTransaction(() => {
        expect(() =>
          runOpenClawAgentWriteTransaction(() => {
            contribute(scope, profile("b"), 20);
            throw new Error("rollback participant");
          }, scope),
        ).toThrow("rollback participant");
      }, scope);
      expect(listSessionEntriesCore({ ...scope, projection: "list" })).toEqual(before);
      expect(readParticipants(scope)).toHaveLength(1);
      expect(observed).toEqual([]);
      runOpenClawAgentWriteTransaction(() => {
        contribute(scope, profile("a"), 30);
        runOpenClawAgentWriteTransaction(() => {
          contribute(scope, profile("b"), 40);
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
      expect(readParticipants(scope)).toEqual([
        aggregate(profile("a"), 2, 10, 30),
        aggregate(profile("b"), 1, 40),
      ]);
    } finally {
      unsubscribe();
    }
  });

  it.each(["participant", "owner"] as const)(
    "keeps cache projection errors from rolling back a recorded %s",
    async (mutation) => {
      const scope = await makeSession("projection-error");
      contribute(scope, profile("a"), 10);
      listSessionEntriesCore({ ...scope, projection: "list" });
      const database = openOpenClawAgentDatabase(scope);
      database.db
        .prepare("UPDATE session_participants SET identity_namespace = ?")
        .run('{"type":"profile","extra":true}');
      if (mutation === "participant") {
        expect(contribute(scope, profile("b"), 20)).toBe("inserted");
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
    },
  );

  it.each([false, true])(
    "refreshes participant order without reloading sibling metadata (selected: %s)",
    async (selected) => {
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
      contribute({ ...scope, sessionKey }, profile("a"), 10);
      contribute({ ...scope, sessionKey }, profile("b"), 20);
      const read = () =>
        listSessionEntriesCore({
          ...scope,
          projection: "list",
          ...(selected ? { sessionKeys: [sessionKey] } : {}),
        });
      read();
      using executions = trackReads(
        database,
        "metadata",
        (sql) => sql.includes('from "session_nodes"') && sql.includes("entry_json"),
      );
      for (const [identity, promptedAt, order] of [
        ["c", 30, ["a", "b", "c"]],
        ["a", 40, ["a", "b", "c"]],
        ["b", 5, ["b", "a", "c"]],
      ] as const) {
        contribute({ ...scope, sessionKey }, profile(identity), promptedAt);
        const entry = read().find((row) => row.sessionKey === sessionKey)?.entry;
        expect(entry?.participants).toEqual(order.map((id) => ({ identity: profile(id) })));
        expect(entry?.participantCount).toBe(3);
      }
      expect(executions.rowCounts.metadata).toBeLessThanOrEqual(3);
    },
  );

  it("does not create a missing agent database during participant reads", async () => {
    expect(listSessionParticipantsReadOnly({ agentId: "absent", env: state.env }).size).toBe(0);
    expect(existsSync(state.agentDir("absent"))).toBe(false);
  });

  it("keeps namespaces and times separate", async () => {
    const scope = await makeSession("collision");
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
    contribute(scope, { type: "agent", id: "same-id" }, 40);
    contribute(scope, remote("same-id", "other-workspace"), 40);
    await closeOpenClawAgentDatabasesAsync();
    closeOpenClawAgentDatabasesForTest();
    const records = readParticipants(scope) ?? [];
    expect(records).toHaveLength(4);
    expect(records).toEqual(
      expect.arrayContaining([
        aggregate(profile("same-id"), 2, 30, 40),
        aggregate(remote("same-id"), 4, 5, 50),
        aggregate(remote("same-id", "other-workspace"), 1, 40),
        aggregate({ type: "agent", id: "same-id" }, 1, 40),
      ]),
    );
  });

  it("keeps count-only worker contributions out of the participant projection and publishes reordered facts", async () => {
    const scope = await makeSession("worker-counts");
    contribute(scope, remote("first"), 10);
    contribute(scope, remote("second"), 20);
    listSessionParticipantsReadOnly(scope);
    listSessionEntriesCore({ ...scope, projection: "list" });
    const database = openOpenClawAgentDatabase(scope);
    await using worker = participantWorker(database, scope);
    const record = (promptedAt: number) =>
      worker.record({ identity: remote("second"), promptedAt });
    using reads = trackReads(database, "projection", (sql) =>
      sql.startsWith('select "session_key", "identity_namespace", "actor_id"'),
    );
    expect(record(30)).toEqual({
      value: "updated",
      projectionChanged: false,
      participants: {},
    });
    expect(reads.counts.projection).toBe(0);
    expect(readParticipants(scope)).toEqual([
      aggregate(remote("first"), 1, 10),
      aggregate(remote("second"), 2, 20, 30),
    ]);
    const participants = ["second", "first"].map((id) => ({ identity: remote(id) }));
    expect(record(5)).toEqual({
      value: "updated",
      projectionChanged: true,
      participants: { participants, participantCount: 2 },
    });
    expect(loadSessionEntry(scope)).toMatchObject({ participants, participantCount: 2 });
    expect(readParticipants(scope)?.[0]).toEqual(aggregate(remote("second"), 3, 5, 30));
    worker.assertSettled();
  });

  it.each([false, true])(
    "updates a merged profile at the admission bound using resident native aliases (canonical row: %s)",
    async (hasCanonicalRow) => {
      const scope = await makeSession("merged-full");
      const old = ensureProfileForEmail("old@example.test", { env: state.env });
      const other = ensureProfileForEmail("other@example.test", { env: state.env });
      const current = ensureProfileForEmail("current@example.test", { env: state.env });
      using _ = {
        [Symbol.dispose]: (await prepareUserProfileCatalog({ env: state.env })).release,
      };
      contribute(scope, profile(old.id), 10);
      contribute(scope, profile(other.id), 10);
      if (hasCanonicalRow) {
        contribute(scope, profile(current.id), 20);
      }
      for (let index = hasCanonicalRow ? 3 : 2; index < MAX_SESSION_PARTICIPANTS; index++) {
        contribute(scope, remote(`remote-${index}`), 30);
      }
      linkEmail("old@example.test", current.id, { env: state.env });
      linkEmail("other@example.test", current.id, { env: state.env });
      const database = openOpenClawAgentDatabase(scope);
      {
        await using worker = participantWorker(database, scope);
        const params = { identity: profile(current.id), promptedAt: 40 };
        for (const writer of ["native", "worker"] as const) {
          const profileReads = observeSqliteReadSql(StatementSync.prototype);
          const transactionSql = vi.spyOn(database.db, "exec");
          try {
            if (writer === "native") {
              expect(recordSessionParticipant(scope, params)).toBe("updated");
            } else {
              expect(worker.record(params)).toMatchObject({ value: "updated" });
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
              expect(transactionSql.mock.calls.some(([sql]) => /SAVEPOINT/i.test(sql))).toBe(false);
            }
          } finally {
            transactionSql.mockRestore();
            profileReads.restore();
          }
        }
        worker.assertSettled();
      }
      const records = readParticipants(scope) ?? [];
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
    },
  );

  it("keeps raw actor identity equality when SQLite replaces a lone surrogate", async () => {
    const scope = await makeSession("raw-identity");
    contribute(scope, remote("\ud800"), 10);
    for (let index = 1; index < MAX_SESSION_PARTICIPANTS; index++) {
      contribute(scope, remote(`remote-${index}`), 10);
    }
    expect(contribute(scope, remote("\ud800"), 20)).toBe("capped");
    expect(readParticipants(scope)).toContainEqual(aggregate(remote("\ufffd"), 1, 10));
  });

  it("keeps the admission bound, unknown first time, reset history, and deletion ownership", async () => {
    const scope = await makeSession("bounded");
    const database = openOpenClawAgentDatabase(scope);
    expect(loadSessionEntry(scope)).toMatchObject({ sessionId: "bounded" });
    database.db.exec("DROP TABLE session_participants");
    expect(loadSessionEntry(scope)).toMatchObject({ sessionId: "bounded" });
    expect(readParticipants(scope)).toBeUndefined();
    expect(
      database.db
        .prepare("SELECT name FROM sqlite_schema WHERE name = 'session_participants'")
        .get(),
    ).toBeUndefined();
    for (let index = 0; index < MAX_SESSION_PARTICIPANTS; index++) {
      expect(contribute(scope, profile(`profile-${index}`), 10)).toBe("inserted");
    }
    const beforeCap = loadSessionEntry(scope);
    const cappedEvents: string[] = [];
    const unsubscribe = onSessionLifecycleEvent((event) => {
      if (event.sessionKey === scope.sessionKey) {
        cappedEvents.push(event.reason);
      }
    });
    try {
      expect(contribute(scope, remote("profile-0"), 10)).toBe("capped");
      expect({ entry: loadSessionEntry(scope), events: cappedEvents }).toEqual({
        entry: beforeCap,
        events: [],
      });
    } finally {
      unsubscribe();
    }
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
    contribute(scope, profile("profile-0"), 20);
    contribute(scope, profile("profile-0"), 20);
    contribute(scope, profile("profile-0"), 15);
    expect(readParticipants(scope)).toContainEqual(aggregate(profile("profile-0"), 4, null, 20));
    await upsertSessionEntryCore(scope, { sessionId: "bounded-reset", updatedAt: 30 });
    expect(loadSessionEntry(scope)?.participants).toHaveLength(MAX_SESSION_PARTICIPANTS);
    const deletion = await deleteSessionEntryLifecycle({
      agentId: "main",
      storePath: database.path,
      target: { canonicalKey: scope.sessionKey, storeKeys: [scope.sessionKey] },
      archiveTranscript: false,
    });
    expect(deletion.deleted).toBe(true);
    expect(readParticipants(scope)).toBeUndefined();
  });

  it("merges alias contributions with current destination writes and unknown timestamps", async () => {
    const canonical = await makeSession("canonical");
    const first = await makeSession("first-alias");
    const second = await makeSession("second-alias");
    contribute(canonical, profile("shared"), 20);
    contribute(first, profile("shared"), 10);
    contribute(first, profile("shared"), 30);
    contribute(second, profile("shared"), 40);
    const database = openOpenClawAgentDatabase(canonical);
    database.db
      .prepare("UPDATE session_participants SET first_prompted_at = NULL WHERE session_key = ?")
      .run(second.sessionKey);
    using reads = trackReads(database, "participants", (sql) =>
      sql.includes('from "session_participants"'),
    );
    runOpenClawAgentWriteTransaction(() => {
      // The second transfer consumes the aggregate written earlier in this transaction.
      for (const keys of [
        [canonical.sessionKey, first.sessionKey, second.sessionKey],
        [first.sessionKey],
      ]) {
        copySessionNodeArtifactsForRepair(database, database, keys, canonical.sessionKey);
      }
    }, canonical);
    expect(reads.counts.participants).toBe(2);

    expect(readParticipants(canonical)).toEqual([aggregate(profile("shared"), 6, null, 40)]);
  });

  it("preserves over-bound repair histories and does not inflate retried cross-store copies", async () => {
    const sourceScope = { agentId: "source", env: state.env, sessionKey: "agent:source:shared" };
    const targetScope = { agentId: "main", env: state.env, sessionKey: "agent:main:shared" };
    await upsertSessionEntryCore(sourceScope, { sessionId: "source", updatedAt: 1 });
    await upsertSessionEntryCore(targetScope, { sessionId: "target", updatedAt: 1 });
    for (let index = 0; index < MAX_SESSION_PARTICIPANTS; index++) {
      contribute(sourceScope, profile(`profile-${index}`), 10);
      contribute(targetScope, remote(`profile-${index}`), 20);
    }
    contribute(sourceScope, profile("profile-0"), 30);
    const source = openOpenClawAgentDatabase({ agentId: "source", env: state.env });
    const target = openOpenClawAgentDatabase({ agentId: "main", env: state.env });
    for (let attempt = 0; attempt < 2; attempt++) {
      copySessionNodeArtifactsForRepair(
        source,
        target,
        [sourceScope.sessionKey],
        targetScope.sessionKey,
      );
    }
    const rows = readParticipants(targetScope) ?? [];
    expect(rows).toHaveLength(64);
    expect(
      rows.find((row) => row.identity.type === "profile" && row.identity.id === "profile-0")
        ?.contributionCount,
    ).toBe(2);
    using reads = trackReads(target, "participants", (sql) =>
      sql.includes('from "session_participants"'),
    );
    expect(contribute(targetScope, profile("profile-0"), 40)).toBe("updated");
    expect(reads.rowCounts.participants).toBeLessThanOrEqual(1);

    expect(contribute(targetScope, profile("overflow"), 40)).toBe("capped");
  });
});
