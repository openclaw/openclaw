import { existsSync } from "node:fs";
import { StatementSync, type DatabaseSync } from "node:sqlite";
import { MessageChannel } from "node:worker_threads";
import { afterEach, expect, it, vi } from "vitest";
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

function withState<Args extends unknown[]>(
  run: (state: OpenClawTestState, ...args: Args) => Promise<void>,
) {
  return (...args: Args) =>
    withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      await captureRuntimeConfigAsyncReader()();
      await run(state, ...args);
    });
}

async function seedSession(state: OpenClawTestState, name: string, agentId = "main") {
  const scope = { agentId, env: state.env, sessionKey: `agent:${agentId}:${name}` };
  await upsertSessionEntryCore(scope, { sessionId: name, updatedAt: 1 });
  return scope;
}

async function seedPair(state: OpenClawTestState, first: string, second: string) {
  return [await seedSession(state, first), await seedSession(state, second)] as const;
}

function withExternalDatabase(path: string, run: (db: DatabaseSync) => void) {
  const database = openNodeSqliteDatabase(path);
  try {
    run(database);
  } finally {
    database.close();
  }
}

function corruptIdentity(db: DatabaseSync, sessionKey?: string) {
  const filter = sessionKey ? " WHERE session_key = ?" : "";
  db.prepare(`UPDATE session_participants SET identity_namespace = ?${filter}`).run(
    '{"type":"profile","extra":true}',
    ...(sessionKey ? [sessionKey] : []),
  );
}

function copyParticipants(
  source: ReturnType<typeof openOpenClawAgentDatabase>,
  target: ReturnType<typeof openOpenClawAgentDatabase>,
  destination: string,
  ...sources: string[]
) {
  copySessionNodeArtifactsForRepair(source, target, sources, destination);
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

type ParticipantScope = Parameters<typeof recordSessionParticipant>[0];
const listEntries = (scope: Parameters<typeof listSessionEntriesCore>[0]) =>
  listSessionEntriesCore({ ...scope, projection: "list" });
const readEntry = (scope: ParticipantScope) =>
  listEntries(scope).find((row) => row.sessionKey === scope.sessionKey)?.entry;
const readParticipants = (scope: ParticipantScope) =>
  listSessionParticipantsReadOnly(scope).get(scope.sessionKey);

function watchSql(
  database: ReturnType<typeof openOpenClawAgentDatabase>,
  matches = (sql: string) => sql.includes('from "session_participants"'),
) {
  const counter = trackSqliteStatementExecutions(
    requireNativeSqliteDatabase(database.db),
    ["matches"],
    (sql) => (matches(sql) ? "matches" : null),
  );
  return { ...counter, [Symbol.dispose]: counter.restore };
}

const participantProjection = (sql: string) =>
  sql.startsWith('select "session_key", "identity_namespace", "actor_id"');

function openWorker(database: ReturnType<typeof openOpenClawAgentDatabase>) {
  const backend = bindSqliteWorkerBackend(undefined, {
    database: database.db,
    databasePath: database.path,
    admit() {},
  });
  const { port1, port2 } = new MessageChannel();
  return {
    record: (scope: ParticipantScope, params: Parameters<typeof recordSessionParticipant>[1]) =>
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

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  vi.useRealTimers();
});

it.each(["local", "foreign"])(
  "publishes fresh participants after an untracked %s write during patch preparation",
  withState(async (state, writer: string) => {
    const scope = await seedSession(state, "changed");
    recordParticipant(scope, remote("before"), 1);
    listEntries(scope);
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
          const update = (connection: DatabaseSync) => {
            connection
              .prepare("UPDATE session_participants SET actor_id = ? WHERE session_key = ?")
              .run("after", scope.sessionKey);
          };
          if (writer === "foreign") {
            withExternalDatabase(database.path, update);
          } else {
            update(requireNativeSqliteDatabase(database.db));
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
  }),
);

it(
  "reuses participant facts across metadata patches",
  withState(async (state) => {
    const scope = await seedSession(state, "busy");
    recordParticipant(scope, remote("existing"), 1);
    const read = () => readEntry(scope);
    read();
    const database = openOpenClawAgentDatabase(scope);
    using reads = watchSql(database, participantProjection);
    for (let index = 0; index < 100; index++) {
      await patchSessionEntryCore(scope, () => ({ label: `Update ${index}` }), {
        skipMaintenance: true,
      });
    }
    // Metadata-only updates retain the participant owner's current revision.
    expect(reads.counts.matches).toBe(0);
    recordParticipant(scope, remote("new"), 2);
    expect(reads.counts.matches).toBe(1);
    expect(read()).toMatchObject({
      label: "Update 99",
      participants: ["existing", "new"].map((id) => ({ identity: remote(id) })),
      participantCount: 2,
    });
  }),
);

it.each(["participant", "external-entry"] as const)(
  "keeps a reentrant observer's newer cached state after an outer %s write",
  withState(async (state, kind: "participant" | "external-entry") => {
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
    const read = () => readEntry(scope);
    read();
    const write = (label: string, time: number, external = false) => {
      if (kind === "participant") {
        recordParticipant(scope, profile(label), time);
      } else if (external) {
        withExternalDatabase(openOpenClawAgentDatabase(scope).path, (database) => {
          database
            .prepare(
              "UPDATE session_nodes SET entry_json = json_set(entry_json, '$.label', ?, '$.updatedAt', ?), updated_at = ? WHERE session_key = ?",
            )
            .run(label, time, time, scope.sessionKey);
        });
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
  }),
);

it(
  "reinstalls tracking after first-use schema rollback and retry",
  withState(async (state) => {
    const scope = { agentId: "main", env: state.env };
    const [target, sibling] = await seedPair(state, "target", "sibling");
    const database = openOpenClawAgentDatabase(scope);
    database.db.exec("DROP TABLE session_participants");
    const read = () => listEntries(scope);
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
    corruptIdentity(requireNativeSqliteDatabase(database.db), sibling.sessionKey);
    recordParticipant(target, profile("b"), 20);
    expect(read).toThrow("Session participant identity is invalid");
  }),
);

it.each([
  { mutation: "participant-before", write: "inserted-target" },
  { mutation: "participant-after", write: "stable-repeat-target" },
  { mutation: "external-participant", write: "inserted-target" },
  { mutation: "session-before", write: "stable-repeat-target" },
])(
  "does not hide an untracked sibling change during participant publication: $mutation, $write",
  withState(async (state, { mutation, write }: { mutation: string; write: string }) => {
    if (mutation === "external-participant") {
      vi.useFakeTimers({ toFake: ["setImmediate"] });
    }
    const scope = { agentId: "main", env: state.env };
    const [target, sibling] = await seedPair(state, "target", "sibling");
    for (const entryScope of [target, sibling]) {
      recordParticipant(entryScope, profile("a"), 10);
    }
    const database = openOpenClawAgentDatabase(scope);
    const read = () => listEntries(scope);
    read();
    const mutate = (db: DatabaseSync) => {
      if (mutation === "session-before") {
        db.prepare(
          "UPDATE session_nodes SET entry_json = json_set(entry_json, '$.label', 'changed') WHERE session_key = ?",
        ).run(sibling.sessionKey);
      } else {
        corruptIdentity(db, sibling.sessionKey);
      }
    };
    if (mutation === "external-participant") {
      withExternalDatabase(database.path, mutate);
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
  }),
);

it(
  "rejects raw-transaction inserts without changing rows",
  withState(async (state) => {
    const scope = await seedSession(state, "raw-transaction");
    recordParticipant(scope, profile("a"), 10);
    const read = () => listEntries(scope);
    const before = read();
    const participantsBefore = readParticipants(scope);
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
    expect(readParticipants(scope)).toEqual(participantsBefore);
  }),
);

it(
  "publishes participants only after the outer commit",
  withState(async (state) => {
    const scope = await seedSession(state, "participant-events");
    recordParticipant(scope, profile("a"), 10);
    const read = () => readEntry(scope);
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
      expect(readParticipants(scope)).toEqual([
        participant(profile("a"), 2, 10, 30),
        participant(profile("b"), 1, 40),
      ]);
    } finally {
      unsubscribe();
    }
  }),
);

it(
  "preserves participants across nested rollback",
  withState(async (state) => {
    const scope = await seedSession(state, "rollback");
    recordParticipant(scope, profile("a"), 10);
    const read = () => listEntries(scope);
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
    expect(readParticipants(scope)).toHaveLength(1);
  }),
);

it.each(["participant", "owner"] as const)(
  "keeps cache projection errors from rolling back a recorded %s",
  withState(async (state, mutation: "participant" | "owner") => {
    const scope = await seedSession(state, "projection-error");
    recordParticipant(scope, profile("a"), 10);
    listEntries(scope);
    const database = openOpenClawAgentDatabase(scope);
    corruptIdentity(requireNativeSqliteDatabase(database.db));
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
    expect(() => listEntries(scope)).toThrow("Session participant identity is invalid");
    expect(
      database.db.prepare("SELECT count(*) AS count FROM session_participants").get()?.count,
    ).toBe(mutation === "participant" ? 2 : 1);
  }),
);

it.each([false, true])(
  "refreshes participant order without reloading sibling metadata (selected: %s)",
  withState(async (state, selected: boolean) => {
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
    using executions = watchSql(
      database,
      (sql) => sql.includes('from "session_nodes"') && sql.includes("entry_json"),
    );
    for (const [identity, promptedAt, order] of [
      ["c", 30, ["a", "b", "c"]],
      ["a", 40, ["a", "b", "c"]],
      ["b", 5, ["b", "a", "c"]],
    ] as const) {
      recordParticipant({ ...scope, sessionKey }, profile(identity), promptedAt);
      const entry = read().find((row) => row.sessionKey === sessionKey)?.entry;
      expect(entry?.participants).toEqual(order.map((id) => ({ identity: profile(id) })));
      expect(entry?.participantCount).toBe(3);
    }
    expect(executions.rowCounts.matches).toBeLessThanOrEqual(3);
  }),
);

it(
  "does not create missing databases on participant reads",
  withState(async (state) => {
    expect(listSessionParticipantsReadOnly({ agentId: "absent", env: state.env }).size).toBe(0);
    expect(existsSync(state.agentDir("absent"))).toBe(false);
  }),
);

it(
  "keeps namespaces and times separate",
  withState(async (state) => {
    const scope = await seedSession(state, "collision");
    for (const [identity, promptedAt] of [
      [remote("same-id"), 10],
      [remote("same-id"), 20],
      [profile("same-id"), 30],
      [profile("same-id"), 40],
      [remote("same-id"), 50],
      [remote("same-id"), 5],
    ] as const) {
      recordParticipant(scope, identity, promptedAt);
    }
    recordParticipant(scope, { type: "agent", id: "same-id" }, 40);
    recordParticipant(scope, remote("same-id", "other-workspace"), 40);
    await closeOpenClawAgentDatabasesAsync();
    closeOpenClawAgentDatabasesForTest();
    const records = readParticipants(scope) ?? [];
    expect(records).toHaveLength(4);
    expect(records).toEqual(
      expect.arrayContaining([
        participant(profile("same-id"), 2, 30, 40),
        participant(remote("same-id"), 4, 5, 50),
        participant(remote("same-id", "other-workspace"), 1, 40),
        participant({ type: "agent", id: "same-id" }, 1, 40),
      ]),
    );
  }),
);

it(
  "projects worker contributions only when order changes",
  withState(async (state) => {
    const scope = await seedSession(state, "worker-counts");
    recordParticipant(scope, remote("first"), 10);
    recordParticipant(scope, remote("second"), 20);
    listSessionParticipantsReadOnly(scope);
    listEntries(scope);
    const database = openOpenClawAgentDatabase(scope);
    await using worker = openWorker(database);
    const record = (promptedAt: number) =>
      worker.record(scope, { identity: remote("second"), promptedAt });
    using reads = watchSql(database, participantProjection);
    expect(record(30)).toEqual({
      value: "updated",
      projectionChanged: false,
      participants: {},
    });
    expect(reads.counts.matches).toBe(0);
    expect(readParticipants(scope)).toEqual([
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
    expect(readParticipants(scope)?.[0]).toEqual(participant(remote("second"), 3, 5, 30));
    worker.assertSettled();
  }),
);

it.each([false, true])(
  "updates a merged profile at the admission bound using resident native aliases (canonical row: %s)",
  withState(async (state, hasCanonicalRow: boolean) => {
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
    {
      await using worker = openWorker(database);
      const params = { identity: profile(current.id), promptedAt: 40 };
      for (const writer of ["native", "worker"] as const) {
        const profileReads = observeSqliteReadSql(StatementSync.prototype);
        const transactionSql = vi.spyOn(database.db, "exec");
        try {
          if (writer === "native") {
            expect(recordSessionParticipant(scope, params)).toBe("updated");
          } else {
            expect(worker.record(scope, params)).toMatchObject({ value: "updated" });
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
  }),
);

it(
  "keeps raw actor identity when SQLite replaces surrogates",
  withState(async (state) => {
    const scope = await seedSession(state, "raw-identity");
    recordParticipant(scope, remote("\ud800"), 10);
    for (let index = 1; index < MAX_SESSION_PARTICIPANTS; index++) {
      recordParticipant(scope, remote(`remote-${index}`), 10);
    }
    expect(recordParticipant(scope, remote("\ud800"), 20)).toBe("capped");
    expect(readParticipants(scope)).toContainEqual(participant(remote("\ufffd"), 1, 10));
  }),
);

it(
  "keeps bounds, unknown timestamps, and reset/deletion ownership",
  withState(async (state) => {
    const scope = await seedSession(state, "bounded");
    const database = openOpenClawAgentDatabase({ agentId: "main", env: state.env });
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
    expect(readParticipants(scope)).toContainEqual(participant(profile("profile-0"), 4, null, 20));
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
  }),
);

it(
  "merges aliases with current writes and unknown timestamps",
  withState(async (state) => {
    const canonical = await seedSession(state, "canonical");
    const first = await seedSession(state, "first-alias");
    const second = await seedSession(state, "second-alias");
    recordParticipant(canonical, profile("shared"), 20);
    recordParticipant(first, profile("shared"), 10);
    recordParticipant(first, profile("shared"), 30);
    recordParticipant(second, profile("shared"), 40);
    const database = openOpenClawAgentDatabase(canonical);
    database.db
      .prepare("UPDATE session_participants SET first_prompted_at = NULL WHERE session_key = ?")
      .run(second.sessionKey);
    using reads = watchSql(database);
    runOpenClawAgentWriteTransaction(() => {
      copyParticipants(
        database,
        database,
        canonical.sessionKey,
        canonical.sessionKey,
        first.sessionKey,
        second.sessionKey,
      );
      // A second transfer must consume the aggregate written earlier in this transaction.
      copyParticipants(database, database, canonical.sessionKey, first.sessionKey);
    }, canonical);
    expect(reads.counts.matches).toBe(2);
    expect(listSessionParticipantsReadOnly(canonical).get(canonical.sessionKey)).toEqual([
      participant(profile("shared"), 6, null, 40),
    ]);
  }),
);

it(
  "preserves over-bound histories across retried cross-store copies",
  withState(async (state) => {
    const sourceScope = await seedSession(state, "shared", "source");
    const targetScope = await seedSession(state, "shared");
    for (let index = 0; index < MAX_SESSION_PARTICIPANTS; index++) {
      recordParticipant(sourceScope, profile(`profile-${index}`), 10);
      recordParticipant(targetScope, remote(`profile-${index}`), 20);
    }
    recordParticipant(sourceScope, profile("profile-0"), 30);
    const source = openOpenClawAgentDatabase({ agentId: "source", env: state.env });
    const target = openOpenClawAgentDatabase({ agentId: "main", env: state.env });
    copyParticipants(source, target, targetScope.sessionKey, sourceScope.sessionKey);
    copyParticipants(source, target, targetScope.sessionKey, sourceScope.sessionKey);
    const rows = listSessionParticipantsReadOnly(targetScope).get(targetScope.sessionKey) ?? [];
    expect(rows).toHaveLength(64);
    expect(
      rows.find((row) => row.identity.type === "profile" && row.identity.id === "profile-0")
        ?.contributionCount,
    ).toBe(2);
    using reads = watchSql(target);
    expect(recordParticipant(targetScope, profile("profile-0"), 40)).toBe("updated");
    expect(reads.rowCounts.matches).toBeLessThanOrEqual(1);
    expect(recordParticipant(targetScope, profile("overflow"), 40)).toBe("capped");
  }),
);
