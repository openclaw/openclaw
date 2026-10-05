import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../test/helpers/promise.js";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { drainFormattedSystemEvents } from "../auto-reply/reply/session-system-events.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../config/io.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import {
  publishSystemEventStoreConfig,
  resolvePhysicalSessionStorePath,
} from "../config/sessions/session-store-path.js";
import { getLastHeartbeatEvent } from "../infra/heartbeat-events.js";
import { assertSqliteSchemaContains } from "../infra/sqlite-schema-contract.js";
import * as workerAdmission from "../infra/sqlite-worker-operation-admission.js";
import { publishSystemEventStoreResolver } from "../infra/system-event-ownership.js";
import {
  enqueueSystemEvent,
  peekSystemEventEntries,
  resetSystemEventsForTest,
} from "../infra/system-events.js";
import * as stateReads from "../state/openclaw-state-db-readonly.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import {
  getOpenClawStateRuntimeSchema,
  STATE_PERSISTENT_SCHEMA_COMPATIBILITY,
} from "../state/openclaw-state-schema-compatibility.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { runOpenClawStateWorkerOperation } from "../state/openclaw-state-worker-store.js";
import { observeMainThreadSql } from "../test-utils/main-thread-sql-spies.test-support.js";
import { recordSessionCreated } from "./session-created.js";
import {
  beginAmbientWatchPrune,
  prepareAmbientGroupWatchTargetsRead,
} from "./session-state-events.ambient-read.js";
import {
  acknowledgeSessionStateNotices,
  getSessionStateVersion,
  getSessionStateVersions,
  handleSessionStateSessionDeleted,
  handleSessionStateSessionReset,
  listSessionStateEventsSince,
  recordSessionStateEventAsync,
  recordSessionCompacted,
  recordSubagentSpawned,
  registerMainSessionGroupWatch,
  registerSessionStateWatch,
  sweepSessionStateWatchNotices,
} from "./session-state-events.js";
import {
  child,
  cleanupSessionStateTestState,
  createDatabaseOptions,
  eventInput,
  nestedWatcher,
  readCursor,
  seedChild,
  watcher,
} from "./session-state-events.test-support.js";
import * as notices from "./session-state-notices.js";

afterEach(async () => {
  vi.restoreAllMocks();
  publishSystemEventStoreResolver(undefined);
  clearRuntimeConfigSnapshot();
  await cleanupSessionStateTestState();
});

it("keeps queued signal cleanup on its captured store and removes newly committed rows", async ({
  signal,
}) => {
  const database = createDatabaseOptions();
  await seedChild(database);
  const { db } = openOpenClawStateDatabase(database);
  const entered = createDeferred();
  const release = createDeferred();
  const blocking = runOpenClawStateWorkerOperation(
    captureOpenClawStateWorkerContext(database),
    async () => {
      entered.resolve();
      await release.promise;
    },
  );
  let resetting: Promise<void> | undefined;
  let deleting: Promise<void> | undefined;
  const read = prepareAmbientGroupWatchTargetsRead(watcher, database);
  try {
    await withinTest(entered.promise, signal);
    resetting = handleSessionStateSessionReset(watcher);
    deleting = handleSessionStateSessionDeleted(child, "main");
    expect(read.isCurrent()).toBe(false);
    const replacement = createDatabaseOptions();
    const replacementDb = openOpenClawStateDatabase(replacement).db;
    for (const connection of [db, replacementDb]) {
      connection
        .prepare(
          "INSERT INTO session_watch_cursors (watcher_session_key, target_session_key, updated_at) VALUES (?, ?, 0)",
        )
        .run(watcher, "late-target");
    }
    release.resolve();
    await withinTest(Promise.all([blocking, resetting, deleting]), signal);
    expect(readCursor(database, watcher, "late-target")).toBeUndefined();
    expect(await getSessionStateVersion(child, "main", database)).toBe(0);
    expect(readCursor(replacement, watcher, "late-target")).toBeDefined();
  } finally {
    read.release();
    release.resolve();
    await Promise.allSettled([blocking, resetting, deleting]);
  }
});

it("revokes ambient reads through signal cleanup and overlapping pruning", async () => {
  const database = createDatabaseOptions();
  const group = "agent:main:telegram:group:cleanup";
  for (const operation of ["reset", "delete", "reset-with-prune"] as const) {
    await registerMainSessionGroupWatch({ sessionKey: group, agentId: "main" }, database);
    const before = prepareAmbientGroupWatchTargetsRead(watcher, database);
    expect(await before.read()).toEqual([group]);
    let finishPrune =
      operation === "reset-with-prune"
        ? beginAmbientWatchPrune(captureOpenClawStateWorkerContext(database).admission.identity.key)
        : undefined;
    const during: ReturnType<typeof prepareAmbientGroupWatchTargetsRead>[] = [];
    const stages: string[] = [];
    const createAdmission = workerAdmission.createSqliteWorkerOperationAdmission;
    const admission = vi
      .spyOn(workerAdmission, "createSqliteWorkerOperationAdmission")
      .mockImplementation((admit, attachment) =>
        createAdmission((request, grant) => {
          stages.push(request.stage);
          expect(before.isCurrent()).toBe(false);
          const read = prepareAmbientGroupWatchTargetsRead(watcher, database);
          during.push(read);
          expect(read.isCurrent()).toBe(false);
          admit(request, grant);
        }, attachment),
      );
    try {
      if (operation !== "delete") {
        await handleSessionStateSessionReset(watcher, database);
      } else {
        await handleSessionStateSessionDeleted(group, "main", database);
      }
      expect(stages).toEqual(["transaction", "commit"]);
      expect(before.isCurrent()).toBe(false);
      for (const read of during) {
        expect(read.isCurrent()).toBe(false);
      }
      if (finishPrune) {
        const held = prepareAmbientGroupWatchTargetsRead(watcher, database);
        try {
          expect(held.isCurrent()).toBe(false);
        } finally {
          held.release();
        }
        finishPrune();
        finishPrune = undefined;
      }
      const after = prepareAmbientGroupWatchTargetsRead(watcher, database);
      try {
        expect(after.isCurrent()).toBe(true);
        expect(await after.read()).toEqual([]);
      } finally {
        after.release();
      }
    } finally {
      finishPrune?.();
      admission.mockRestore();
      before.release();
      during.forEach((read) => read.release());
    }
  }
});

it("keeps adoption and lifecycle signal SQL off the caller thread", async () => {
  const database = createDatabaseOptions();
  await seedChild(database);
  const { db } = openOpenClawStateDatabase(database);
  db.prepare(
    "INSERT INTO session_watch_cursors (watcher_session_key, target_session_key, updated_at) VALUES (?, ?, 0)",
  ).run(child, watcher);
  const sql = observeHostDataSql();
  try {
    const adopted = await recordSessionStateEventAsync(
      eventInput({ kind: "adopted", watcherSessionKeys: [] }),
      { ...database, now: 0 },
    );
    expect(adopted?.kind).toBe("adopted");
    expect(sql.queries).toEqual([]);
    await handleSessionStateSessionReset(child, database);
    expect(sql.queries).toEqual([]);
    await handleSessionStateSessionDeleted(child, "main", database);
    // Upstream-link deletion retains its released synchronous SDK owner in this cutover.
    expect(
      sql.queries.filter((query) =>
        /\bsession_(?:state_events|state_heads|watch_cursors)\b/.test(query),
      ),
    ).toEqual([]);
  } finally {
    sql.restore();
  }
  expect(await getSessionStateVersion(child, "main", database)).toBe(0);
  expect(readCursor(database, child, watcher)).toBeUndefined();
});

it("preserves older readers and version markers when watcher provenance is first written", async () => {
  const database = createDatabaseOptions();
  await upsertSessionEntryCore(
    { sessionKey: watcher, env: database.env },
    { sessionId: "legacy-watcher", updatedAt: Date.now() },
  );
  await seedChild(database);
  const now = Date.now();
  const event = (await recordSessionStateEventAsync(eventInput(), { ...database, now }))!;
  resetSystemEventsForTest();
  await closeOpenClawStateDatabaseAsync();
  const before = openOpenClawStateDatabase(database);
  before.db
    .prepare("UPDATE session_state_events SET occurred_at = ? WHERE sequence = ?")
    .run(now - 30 * 24 * 60 * 60_000 - 1, event.sequence);
  before.db.exec("UPDATE session_watch_cursors SET notified_sequence = 0");
  before.db.exec("ALTER TABLE session_watch_cursors DROP COLUMN watcher_store_path");
  const userVersion = before.db.prepare("PRAGMA user_version").get();
  closeOpenClawStateDatabaseForTest();
  const reopened = openOpenClawStateDatabase(database);
  const schemaBeforeRead = reopened.db.prepare("PRAGMA schema_version").get();
  expect(await getSessionStateVersion(child, "main", database)).toBe(event.sequence);
  const pending = await listSessionStateEventsSince(child, "main", 0, 200, database);
  expect(pending.events.map((entry) => entry.sequence)).toContain(event.sequence);
  await sweepSessionStateWatchNotices({ ...database, now });
  expect(readCursor(database)?.notified_sequence).toBe(event.sequence);
  expect(peekSystemEventEntries(watcher)).toEqual([]);
  expect(getLastHeartbeatEvent()).toMatchObject({ status: "skipped", reason: "store-replaced" });
  const retained = await listSessionStateEventsSince(child, "main", 0, 200, database);
  expect(retained.events.map((entry) => entry.sequence)).not.toContain(event.sequence);
  expect(reopened.db.prepare("PRAGMA schema_version").get()).toEqual(schemaBeforeRead);
  expect(
    reopened.db
      .prepare(
        "SELECT name FROM pragma_table_info('session_watch_cursors') WHERE name = 'watcher_store_path'",
      )
      .get(),
  ).toBeUndefined();

  await seedChild(database, nestedWatcher);
  assertSqliteSchemaContains(
    reopened.db,
    reopened.path,
    getOpenClawStateRuntimeSchema({ includeVersionLazyAdditiveTables: false }).replace(
      /^ {2}(?:watcher_store_path|requester_store_path|controller_store_path) TEXT,\n/gm,
      "",
    ),
    STATE_PERSISTENT_SCHEMA_COMPATIBILITY,
  );
  reopened.db
    .prepare(
      "INSERT INTO session_watch_cursors (watcher_session_key, target_session_key, updated_at) VALUES (?, ?, ?)",
    )
    .run(watcher, "legacy-target", Date.now());
  expect(
    reopened.db
      .prepare(
        "SELECT last_seen_sequence, watcher_store_path FROM session_watch_cursors WHERE target_session_key = 'legacy-target'",
      )
      .get(),
  ).toEqual({ last_seen_sequence: 0, watcher_store_path: null });
  const installedSchema = reopened.db.prepare("PRAGMA schema_version").get();
  await recordSessionStateEventAsync(eventInput(), database);
  expect(reopened.db.prepare("PRAGMA schema_version").get()).toEqual(installedSchema);
  expect(reopened.db.prepare("PRAGMA user_version").get()).toEqual(userVersion);
});

it("records creation, compaction, spawn and periodic retention without caller-thread SQL", async () => {
  const database = createDatabaseOptions();
  const now = Date.now() + 60 * 60_000;
  vi.spyOn(Date, "now").mockReturnValue(now);
  openOpenClawStateDatabase(database)
    .db.prepare(
      "INSERT INTO session_state_events (session_key, agent_id, kind, actor_type, occurred_at, summary) VALUES (?, 'main', 'compacted', 'system', ?, 'expired')",
    )
    .run(child, now - 30 * 24 * 60 * 60_000 - 1);
  const entry = {
    sessionId: "created-child",
    updatedAt: now,
    createdActor: { type: "system" as const },
  };
  const sql = observeMainThreadSql();
  try {
    sql.calibrate();
    for (let attempt = 0; attempt < 2; attempt++) {
      await recordSessionCreated({}, { sessionKey: child, agentId: "main", entry });
      await recordSessionCompacted({
        sessionKey: child,
        operationId: "compact-child",
        agentId: "main",
      });
      await recordSubagentSpawned({
        childSessionKey: child,
        childRunId: "spawn-child",
        requesterSessionKey: nestedWatcher,
        agentId: "main",
      });
    }
    expect(sql.count()).toBe(0);
  } finally {
    sql.restore();
  }
  const events = (await listSessionStateEventsSince(child, "main", 0, 200, database)).events;
  expect(events.map((event) => event.kind)).toEqual(["created", "compacted", "child_spawned"]);
  const spawned = expectDefined(events.at(-1), "child spawn");
  expect(readCursor(database, nestedWatcher)).toEqual({
    last_seen_sequence: spawned.sequence,
    notified_sequence: spawned.sequence,
    material_sequence: spawned.sequence,
  });
  expect(peekSystemEventEntries(nestedWatcher)).toHaveLength(0);
  expect(peekSystemEventEntries(watcher)).toHaveLength(1);
});

it("discovers a cold custom watcher store without caller-thread SQL", async () => {
  const database = createDatabaseOptions();
  const storePath = path.join(database.env.OPENCLAW_STATE_DIR, "custom", "sessions.json");
  const cfg = { session: { store: storePath } };
  await upsertSessionEntryCore(
    { sessionKey: watcher, storePath, env: database.env },
    { sessionId: "custom-watcher", updatedAt: 1 },
  );
  setRuntimeConfigSnapshot(cfg);
  publishSystemEventStoreConfig(cfg);
  const sql = observeMainThreadSql();
  try {
    sql.calibrate();
    await recordSubagentSpawned({
      childSessionKey: child,
      childRunId: "custom-store-spawn",
      requesterSessionKey: watcher,
      agentId: "main",
    });
    expect(sql.count()).toBe(0);
    publishSystemEventStoreConfig(cfg);
    await recordSessionCreated(cfg, {
      sessionKey: child,
      agentId: "main",
      entry: { sessionId: "custom-created", updatedAt: 1, createdActor: { type: "system" } },
    });
    expect(sql.count()).toBe(0);
    expect(
      await registerSessionStateWatch(
        { watcherSessionKey: watcher, targetSessionKey: child },
        database,
      ),
    ).toBe(true);
    expect(sql.count()).toBe(0);
    expect(
      await registerMainSessionGroupWatch(
        { sessionKey: "agent:main:telegram:group:custom", agentId: "main" },
        database,
      ),
    ).toBe(true);
    expect(sql.count()).toBe(0);
  } finally {
    sql.restore();
  }
  expect(
    openOpenClawStateDatabase(database)
      .db.prepare("SELECT DISTINCT watcher_store_path FROM session_watch_cursors")
      .all(),
  ).toEqual([{ watcher_store_path: path.join(path.dirname(storePath), "openclaw-agent.sqlite") }]);
});

it("retains the creation database while notice preparation yields", async () => {
  const database = createDatabaseOptions();
  const entered = createDeferred();
  const prepared = createDeferred<string>();
  const storePath = resolvePhysicalSessionStorePath({ sessionKey: watcher, env: database.env });
  publishSystemEventStoreResolver(
    () => storePath,
    () => {
      entered.resolve();
      return prepared.promise;
    },
  );
  const recording = recordSessionCreated(
    {},
    {
      sessionKey: child,
      entry: { sessionId: "original-store", updatedAt: 1, createdActor: { type: "system" } },
    },
  );
  await entered.promise;
  const replacement = createDatabaseOptions();
  prepared.resolve(storePath);
  await recording;
  expect((await listSessionStateEventsSince(child, "main", 0, 200, database)).events).toMatchObject(
    [{ kind: "created", sessionId: "original-store" }],
  );
  expect((await listSessionStateEventsSince(child, "main", 0, 200, replacement)).events).toEqual(
    [],
  );
});

it("does not acknowledge a replacement store from an older consumed notice", async () => {
  const database = createDatabaseOptions();
  const originalStore = resolvePhysicalSessionStorePath({
    sessionKey: nestedWatcher,
    env: database.env,
  });
  let currentStore = originalStore;
  publishSystemEventStoreResolver(() => currentStore);
  expect(
    await registerSessionStateWatch(
      { watcherSessionKey: nestedWatcher, targetSessionKey: child },
      database,
    ),
  ).toBe(true);
  await recordSessionStateEventAsync(eventInput({ watcherSessionKeys: [] }), database);
  const before = readCursor(database, nestedWatcher);
  const entered = createDeferred();
  const release = createDeferred();
  const blocking = runOpenClawStateWorkerOperation(
    captureOpenClawStateWorkerContext(database),
    async () => {
      entered.resolve();
      await release.promise;
    },
  );
  let draining: Promise<string | undefined> | undefined;
  try {
    await entered.promise;
    draining = drainFormattedSystemEvents({
      cfg: {},
      agentId: "main",
      sessionKey: nestedWatcher,
      isMainSession: false,
      isNewSession: false,
    });
    expect(peekSystemEventEntries(nestedWatcher)).toHaveLength(0);
    currentStore = `${originalStore}.replacement`;
    openOpenClawStateDatabase(database)
      .db.prepare(
        "UPDATE session_watch_cursors SET watcher_store_path = ? WHERE watcher_session_key = ?",
      )
      .run(currentStore, nestedWatcher);
    release.resolve();
    await blocking;
    expect(await draining).toBeUndefined();
    expect(readCursor(database, nestedWatcher)).toEqual(before);
    expect(peekSystemEventEntries(nestedWatcher)).toHaveLength(0);
  } finally {
    release.resolve();
    await blocking;
    await draining;
  }
});

it("preserves consumed events across a same-store resolver handoff while acknowledgment waits", async () => {
  const database = createDatabaseOptions();
  const storePath = resolvePhysicalSessionStorePath({
    sessionKey: nestedWatcher,
    env: database.env,
  });
  publishSystemEventStoreResolver(() => storePath);
  expect(
    await registerSessionStateWatch(
      { watcherSessionKey: nestedWatcher, targetSessionKey: child },
      database,
    ),
  ).toBe(true);
  await recordSessionStateEventAsync(eventInput({ watcherSessionKeys: [] }), database);
  enqueueSystemEvent("ordinary queued event", { sessionKey: nestedWatcher });
  const entered = createDeferred();
  const release = createDeferred();
  const blocking = runOpenClawStateWorkerOperation(
    captureOpenClawStateWorkerContext(database),
    async () => {
      entered.resolve();
      await release.promise;
    },
  );
  let draining: Promise<string | undefined> | undefined;
  try {
    await entered.promise;
    draining = drainFormattedSystemEvents({
      cfg: {},
      agentId: "main",
      sessionKey: nestedWatcher,
      isMainSession: false,
      isNewSession: false,
    });
    expect(peekSystemEventEntries(nestedWatcher)).toHaveLength(0);
    publishSystemEventStoreResolver(() => storePath);
    release.resolve();
    await blocking;
    const formatted = await draining;
    expect(formatted).toContain("ordinary queued event");
    expect(formatted).toContain(`Session "${child}" changed`);
  } finally {
    release.resolve();
    await blocking;
    await draining;
  }
});

it("rechecks acknowledged, rebound, and advanced cursors after sweep discovery", async ({
  signal,
}) => {
  const database = createDatabaseOptions();
  await upsertSessionEntryCore(
    { sessionKey: nestedWatcher, env: database.env },
    { sessionId: "sweep-watcher", updatedAt: 1 },
  );
  const storePath = resolvePhysicalSessionStorePath({
    sessionKey: nestedWatcher,
    env: database.env,
  });
  publishSystemEventStoreResolver(() => storePath);
  const acked = `${child}-acked`;
  const rebound = `${child}-rebound`;
  const advanced = `${child}-advanced`;
  const { db } = openOpenClawStateDatabase(database);
  const insert = db.prepare(`
    INSERT INTO session_watch_cursors
      (watcher_session_key, target_session_key, watcher_store_path, last_seen_sequence,
       notified_sequence, material_sequence, updated_at)
    VALUES (?, ?, ?, 1, 3, 3, ?)
  `);
  for (const target of [acked, rebound, advanced]) {
    insert.run(nestedWatcher, target, storePath, Date.now());
  }
  const discovered = createDeferred();
  const release = createDeferred();
  const executeRead = stateReads.executeExistingOpenClawStateRead;
  const read = vi
    .spyOn(stateReads, "executeExistingOpenClawStateRead")
    .mockImplementation(async (...args) => {
      const result = await executeRead(...args);
      if (args[1].type === "sessionState.pendingNotices") {
        discovered.resolve();
        await release.promise;
      }
      return result;
    });
  const sweeping = sweepSessionStateWatchNotices(database);
  try {
    await withinTest(
      awaitGateBeforeSettlement(
        discovered.promise,
        sweeping,
        "Notice sweep settled before reading pending cursors",
      ),
      signal,
    );
    await acknowledgeSessionStateNotices(
      nestedWatcher,
      [{ targetSessionKey: acked, watcherStorePath: storePath }],
      database,
    );
    db.prepare(
      `UPDATE session_watch_cursors
       SET watcher_store_path = ?, last_seen_sequence = 5,
           notified_sequence = 11, material_sequence = 13
       WHERE watcher_session_key = ? AND target_session_key = ?`,
    ).run(`${storePath}.replacement`, nestedWatcher, rebound);
    db.prepare(
      `UPDATE session_watch_cursors SET material_sequence = 7
       WHERE watcher_session_key = ? AND target_session_key = ?`,
    ).run(nestedWatcher, advanced);
    release.resolve();
    await sweeping;

    expect(readCursor(database, nestedWatcher, acked)).toEqual({
      last_seen_sequence: 3,
      notified_sequence: 3,
      material_sequence: 3,
    });
    expect(readCursor(database, nestedWatcher, rebound)).toEqual({
      last_seen_sequence: 5,
      notified_sequence: 11,
      material_sequence: 13,
    });
    expect(readCursor(database, nestedWatcher, advanced)).toEqual({
      last_seen_sequence: 1,
      notified_sequence: 7,
      material_sequence: 7,
    });
    const queued = peekSystemEventEntries(nestedWatcher);
    expect(queued).toHaveLength(1);
    expect(queued[0]?.text).toContain(`Session "${advanced}" changed`);
    expect(queued[0]?.text).toContain("changesSince 1");
  } finally {
    release.resolve();
    await sweeping;
    read.mockRestore();
  }
});

it("reads session state and commits watch registration and acknowledgment without caller-thread SQL", async () => {
  const database = createDatabaseOptions();
  const group = "agent:main:telegram:group:worker-boundary";
  const events = await Promise.all(
    Array.from({ length: 201 }, async (_, index) =>
      expectDefined(
        await recordSessionStateEventAsync(
          eventInput({
            sessionKey: "global",
            watcherSessionKeys: [],
            summary: `main event ${index}`,
          }),
          database,
        ),
        "seeded main event",
      ),
    ),
  );
  const mainHead = expectDefined(events.at(-1), "main head");
  const opsHead = expectDefined(
    await recordSessionStateEventAsync(
      eventInput({ sessionKey: "global", agentId: "ops", watcherSessionKeys: [] }),
      database,
    ),
    "seeded ops event",
  );
  const constructorHead = expectDefined(
    await recordSessionStateEventAsync(
      eventInput({ sessionKey: "global", agentId: "constructor", watcherSessionKeys: [] }),
      database,
    ),
    "seeded constructor-agent event",
  );
  const sql = observeMainThreadSql();
  const measure = async <T>(label: string, operation: () => T | Promise<T>): Promise<T> => {
    sql.clear();
    const result = await operation();
    expect.soft(sql.count(), label).toBe(0);
    return result;
  };
  try {
    sql.calibrate();
    expect(
      await measure("single session version", () =>
        getSessionStateVersion("global", "main", database),
      ),
    ).toBe(mainHead.sequence);
    expect(
      await measure("prototype-named agent version", () =>
        getSessionStateVersion("global", "constructor", database),
      ),
    ).toBe(constructorHead.sequence);
    expect(
      await measure("composite session versions", () =>
        getSessionStateVersions(
          [
            { sessionKey: "global", agentId: "main" },
            { sessionKey: "global", agentId: "ops" },
            { sessionKey: "global", agentId: "constructor" },
          ],
          database,
        ),
      ),
    ).toEqual({
      main: { global: mainHead.sequence },
      ops: { global: opsHead.sequence },
      constructor: { global: constructorHead.sequence },
    });
    const page = await measure("bounded event page", () =>
      listSessionStateEventsSince("global", "main", 0, 500, database),
    );
    expect(page.events).toHaveLength(200);
    expect(page.events[0]?.summary).toBe("main event 0");
    expect(page.events.at(-1)?.summary).toBe("main event 199");
    expect(page.truncated).toBe(true);
    expect(page.historyGap).toBe(false);

    expect(
      await measure("explicit watch registration", () =>
        registerSessionStateWatch(
          { watcherSessionKey: nestedWatcher, targetSessionKey: child },
          database,
        ),
      ),
    ).toBe(true);
    const frozen = expectDefined(
      await recordSessionStateEventAsync(eventInput({ watcherSessionKeys: [] }), database),
      "frozen child notification",
    );
    const interleaved = expectDefined(
      await recordSessionStateEventAsync(eventInput({ watcherSessionKeys: [] }), database),
      "interleaved child event",
    );
    const watcherStorePath = peekSystemEventEntries(nestedWatcher)[0]?.sessionStorePath ?? null;
    await measure("explicit watch acknowledgment", () =>
      acknowledgeSessionStateNotices(
        nestedWatcher,
        [{ targetSessionKey: child, watcherStorePath }],
        database,
      ),
    );
    expect(readCursor(database, nestedWatcher)).toEqual({
      last_seen_sequence: frozen.sequence,
      notified_sequence: interleaved.sequence,
      material_sequence: interleaved.sequence,
    });

    for (const label of ["initial group watch", "existing group watch"]) {
      expect(
        await measure(label, () =>
          registerMainSessionGroupWatch({ sessionKey: group, agentId: "main" }, database),
        ),
      ).toBe(true);
    }
    const groupFrozen = expectDefined(
      await recordSessionStateEventAsync(
        eventInput({ sessionKey: group, watcherSessionKeys: [] }),
        database,
      ),
      "frozen group notification",
    );
    const groupInterleaved = expectDefined(
      await recordSessionStateEventAsync(
        eventInput({ sessionKey: group, watcherSessionKeys: [] }),
        database,
      ),
      "interleaved group event",
    );
    expect(peekSystemEventEntries(watcher)).toHaveLength(1);
    expect(
      await measure("system-event drain acknowledgment", () =>
        drainFormattedSystemEvents({
          cfg: {},
          agentId: "main",
          sessionKey: watcher,
          isMainSession: false,
          isNewSession: false,
        }),
      ),
    ).toContain(`Session "${group}" changed`);
    expect(readCursor(database, watcher, group)).toEqual({
      last_seen_sequence: groupFrozen.sequence,
      notified_sequence: groupInterleaved.sequence,
      material_sequence: groupInterleaved.sequence,
    });
    expect(peekSystemEventEntries(watcher)).toHaveLength(1);
    expect(peekSystemEventEntries(watcher)[0]?.text).toContain(
      `changesSince ${groupFrozen.sequence}`,
    );
  } finally {
    sql.restore();
  }
});

it("rolls back watch writes when the system-event store changes at transaction or commit admission", async () => {
  const database = createDatabaseOptions();
  const originalStore = resolvePhysicalSessionStorePath({
    sessionKey: nestedWatcher,
    env: database.env,
  });
  let currentStore = originalStore;
  publishSystemEventStoreResolver(() => currentStore);
  const createAdmission = workerAdmission.createSqliteWorkerOperationAdmission;
  for (const operation of ["register", "acknowledge", "spawn"] as const) {
    for (const stage of ["transaction", "commit"] as const) {
      currentStore = originalStore;
      const targetSessionKey = `${child}-${operation}-${stage}`;
      if (operation === "acknowledge") {
        expect(
          await registerSessionStateWatch(
            { watcherSessionKey: nestedWatcher, targetSessionKey },
            database,
          ),
        ).toBe(true);
        for (let index = 0; index < 2; index++) {
          await recordSessionStateEventAsync(
            eventInput({ sessionKey: targetSessionKey, watcherSessionKeys: [] }),
            database,
          );
        }
      }
      const before = readCursor(database, nestedWatcher, targetSessionKey);
      const notice = vi.spyOn(notices, "enqueueSessionStateNotice");
      let witnessed = false;
      const admission = vi
        .spyOn(workerAdmission, "createSqliteWorkerOperationAdmission")
        .mockImplementation((admit, attachment) =>
          createAdmission((request, grant) => {
            if (request.stage === stage) {
              witnessed = true;
              currentStore = `${originalStore}.replacement`;
            }
            admit(request, grant);
          }, attachment),
        );
      try {
        if (operation === "register") {
          expect(
            await registerSessionStateWatch(
              { watcherSessionKey: nestedWatcher, targetSessionKey },
              database,
            ),
          ).toBe(false);
        } else if (operation === "spawn") {
          await recordSubagentSpawned({
            childSessionKey: targetSessionKey,
            childRunId: `spawn-${stage}`,
            requesterSessionKey: nestedWatcher,
            agentId: "main",
          });
          expect(await getSessionStateVersion(targetSessionKey, "main", database)).toBe(0);
        } else {
          await acknowledgeSessionStateNotices(
            nestedWatcher,
            [{ targetSessionKey, watcherStorePath: originalStore }],
            database,
          );
        }
        expect(witnessed, `${operation} ${stage} grant`).toBe(true);
        expect(readCursor(database, nestedWatcher, targetSessionKey)).toEqual(before);
        expect(notice).not.toHaveBeenCalled();
      } finally {
        admission.mockRestore();
        notice.mockRestore();
      }
    }
  }
});

it("refuses a replaced owner before invoking its cold store discovery at commit", async () => {
  const database = createDatabaseOptions();
  openOpenClawStateDatabase(database);
  const originalStore = resolvePhysicalSessionStorePath({
    sessionKey: nestedWatcher,
    env: database.env,
  });
  publishSystemEventStoreResolver(() => originalStore);
  const replacementDiscovery = vi.fn(() => {
    throw new Error("A retired admission must not invoke replacement store discovery");
  });
  const createAdmission = workerAdmission.createSqliteWorkerOperationAdmission;
  let witnessed = false;
  const admission = vi
    .spyOn(workerAdmission, "createSqliteWorkerOperationAdmission")
    .mockImplementation((admit, attachment) =>
      createAdmission((request, grant) => {
        if (request.stage === "commit") {
          witnessed = true;
          publishSystemEventStoreResolver(replacementDiscovery);
        }
        admit(request, grant);
      }, attachment),
    );
  try {
    expect(
      await registerSessionStateWatch(
        { watcherSessionKey: nestedWatcher, targetSessionKey: child },
        database,
      ),
    ).toBe(false);
    expect(witnessed).toBe(true);
    expect(replacementDiscovery).not.toHaveBeenCalled();
    expect(readCursor(database, nestedWatcher)).toBeUndefined();
  } finally {
    admission.mockRestore();
  }
});
