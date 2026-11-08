import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../test/helpers/promise.js";
import * as sessionEvents from "../auto-reply/reply/session-event-handoff.js";
import { drainFormattedSystemEvents } from "../auto-reply/reply/session-system-events.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../config/io.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import {
  publishSystemEventStoreConfig,
  resolvePhysicalSessionStorePath,
} from "../config/sessions/session-store-path.js";
import { getLastHeartbeatEvent } from "../infra/heartbeat-events.js";
import { assertSqliteSchemaContains } from "../infra/sqlite-schema-contract.test-support.js";
import * as workerAdmission from "../infra/sqlite-worker-operation-admission.js";
import { sqliteWorkerOwnerProbe as probe } from "../infra/sqlite-worker-owner-probe.test-support.js";
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
  STATE_RUNTIME_SCHEMA_COMPATIBILITY,
} from "../state/openclaw-state-schema-compatibility.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { runOpenClawStateWorkerOperation } from "../state/openclaw-state-worker-store.js";
import { observeMainThreadSql } from "../test-utils/main-thread-sql-spies.test-support.js";
import { requireNativeSqliteDatabase } from "../test-utils/native-sqlite.js";
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
  recordSubagentSpawned,
  registerMainSessionGroupWatch,
  registerSessionStateWatch,
  sweepSessionStateWatchNotices,
} from "./session-state-events.js";
import { pruneSessionStateEvents } from "./session-state-events.prune.js";
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
import { acknowledgeSessionStateNoticesInWorker } from "./session-state-notice-acknowledgment.js";
import * as notices from "./session-state-notices.js";
import { upsertSessionUpstreamLink } from "./session-upstream-links.js";
import { readSessionUpstreamLinkInDatabase } from "./session-upstream-links.kernel.js";

type Database = ReturnType<typeof createDatabaseOptions>;
let database: Database;
const query = (sql: string) => openOpenClawStateDatabase(database).db.prepare(sql);
const stateEvents = async (options = database) =>
  (await listSessionStateEventsSince(child, "main", 0, 200, options)).events;
const seedWatcher = (sessionKey = nestedWatcher, storePath?: string, updatedAt = Date.now()) =>
  upsertSessionEntryCore(
    { sessionKey, storePath, env: database.env },
    { sessionId: `watcher:${sessionKey}`, updatedAt },
  );
function insertCursor(sessionKey: string, target: string, storePath: string) {
  query(`INSERT INTO session_watch_cursors
    (watcher_session_key, target_session_key, watcher_store_path, last_seen_sequence,
     notified_sequence, material_sequence, updated_at)
    VALUES (?, ?, ?, 1, 3, 3, ?)`).run(sessionKey, target, storePath, Date.now());
}
const creation = (sessionId: string) => ({
  sessionKey: child,
  entry: { sessionId, updatedAt: 1, createdActor: { type: "system" as const } },
});
const acknowledge = (targetSessionKey: string, watcherStorePath: string | null) =>
  acknowledgeSessionStateNotices(nestedWatcher, [{ targetSessionKey, watcherStorePath }], database);
const watch = (targetSessionKey = child) =>
  registerSessionStateWatch({ watcherSessionKey: nestedWatcher, targetSessionKey }, database);
const groupWatch = (sessionKey: string) =>
  registerMainSessionGroupWatch({ sessionKey, agentId: "main" }, database);
const drain = (sessionKey: string) =>
  drainFormattedSystemEvents({
    cfg: {},
    agentId: "main",
    sessionKey,
    isMainSession: false,
    isNewSession: false,
  });
const watcherStore = () =>
  resolvePhysicalSessionStorePath({ sessionKey: nestedWatcher, env: database.env });
async function record(overrides: Parameters<typeof eventInput>[0] = {}) {
  return expectDefined(
    await recordSessionStateEventAsync(eventInput(overrides), database),
    "seeded event",
  );
}
function expectCursor(values: [number, number, number], key = nestedWatcher, target = child) {
  const [last_seen_sequence, notified_sequence, material_sequence] = values;
  expect(readCursor(database, key, target)).toEqual({
    last_seen_sequence,
    notified_sequence,
    material_sequence,
  });
}
function holdWorker() {
  const entered = createDeferred();
  const release = createDeferred();
  const blocking = runOpenClawStateWorkerOperation(
    captureOpenClawStateWorkerContext(database),
    async () => {
      entered.resolve();
      await release.promise;
    },
  );
  return { entered, release, blocking };
}

beforeEach(() => {
  setRuntimeConfigSnapshot({});
  database = createDatabaseOptions();
});

afterEach(async () => {
  vi.restoreAllMocks();
  publishSystemEventStoreResolver(undefined);
  clearRuntimeConfigSnapshot();
  await cleanupSessionStateTestState();
});

it("keeps queued signal cleanup on its captured store and removes newly committed rows", async ({
  signal,
}) => {
  await seedChild(database);
  const lateTarget = "agent:main:late-target";
  const { db } = openOpenClawStateDatabase(database);
  const { entered, release, blocking } = holdWorker();
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
        .run(watcher, lateTarget);
    }
    for (const options of [database, replacement]) {
      expect(
        upsertSessionUpstreamLink(
          {
            sessionKey: child,
            agentId: "main",
            catalogId: "codex",
            hostId: "gateway:local",
            threadId: "late-link",
            upstreamKind: "codex-app-server",
            upstreamRef: null,
            marker: null,
          },
          options,
        ),
      ).toBe(true);
    }
    release.resolve();
    await withinTest(Promise.all([blocking, resetting, deleting]), signal);
    expect(readCursor(database, watcher, lateTarget)).toBeUndefined();
    expect(await getSessionStateVersion(child, "main", database)).toBe(0);
    expect(readSessionUpstreamLinkInDatabase(db, child, "main")).toBeUndefined();
    expect(readCursor(replacement, watcher, lateTarget)).toBeDefined();
    expect(readSessionUpstreamLinkInDatabase(replacementDb, child, "main")?.threadId).toBe(
      "late-link",
    );
  } finally {
    read.release();
    release.resolve();
    await Promise.allSettled([blocking, resetting, deleting]);
  }
});

it("revokes ambient reads through signal cleanup and overlapping pruning", async () => {
  const group = "agent:main:telegram:group:cleanup";
  for (const operation of ["reset", "delete", "reset-with-prune"] as const) {
    await groupWatch(group);
    const before = prepareAmbientGroupWatchTargetsRead(watcher, database);
    expect(await before.read()).toEqual([group]);
    let finishPrune =
      operation === "reset-with-prune"
        ? beginAmbientWatchPrune(captureOpenClawStateWorkerContext(database).admission.identity.key)
        : undefined;
    const during: ReturnType<typeof prepareAmbientGroupWatchTargetsRead>[] = [];
    const stages: string[] = [];
    using writer = probe.writerLock(openOpenClawStateDatabase(database).path);
    const admission = probe.admission(workerAdmission, (request, grant, admit) => {
      stages.push(request.stage);
      writer.observe(request.stage);
      expect(before.isCurrent()).toBe(false);
      const read = prepareAmbientGroupWatchTargetsRead(watcher, database);
      during.push(read);
      expect(read.isCurrent()).toBe(false);
      admit(request, grant);
    });
    try {
      if (operation !== "delete") {
        await handleSessionStateSessionReset(watcher, database);
      } else {
        await handleSessionStateSessionDeleted(group, "main", database);
      }
      expect(stages).toEqual(["transaction", "commit"]);
      expect(writer.observed).toEqual(["transaction:free", "commit:held"]);
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

it("keeps the writer free during session signal admission and commits current cursor state", async () => {
  await seedWatcher();
  const storePath = watcherStore();
  publishSystemEventStoreResolver(() => storePath);
  using writer = probe.writerLock(openOpenClawStateDatabase(database).path);
  let acceptingAcknowledgment = false;
  const admission = probe.admission(workerAdmission, (request, grant, admit) => {
    writer.observe(request.stage);
    if (acceptingAcknowledgment && writer.observed.at(-1) === "transaction:free") {
      // Another writer can advance the notice while admission waits. Acknowledgment
      // must consume that committed cursor after acquiring its own transaction.
      query("UPDATE session_watch_cursors SET notified_sequence = material_sequence").run();
    }
    admit(request, grant);
  });
  const expectAdmission = () => {
    expect.soft(writer.observed).toEqual(["transaction:free", "commit:held"]);
    writer.observed.length = 0;
  };
  try {
    expect(await watch()).toBe(true);
    expectAdmission();
    const first = expectDefined(
      await recordSessionStateEventAsync(eventInput({ watcherSessionKeys: [] }), {
        ...database,
        now: 0,
      }),
      "first signal",
    );
    expectAdmission();
    const second = expectDefined(
      await recordSessionStateEventAsync(eventInput({ watcherSessionKeys: [] }), {
        ...database,
        now: 0,
      }),
      "second signal",
    );
    expectAdmission();
    expectCursor([0, first.sequence, second.sequence]);
    acceptingAcknowledgment = true;
    await acknowledge(child, storePath);
    acceptingAcknowledgment = false;
    expectAdmission();
    expectCursor([second.sequence, second.sequence, second.sequence]);
    await pruneSessionStateEvents({ ...database, force: true, now: 31 * 24 * 60 * 60_000 });
    expectAdmission();
    expect(await listSessionStateEventsSince(child, "main", 0, 200, database)).toMatchObject({
      events: [],
      historyGap: true,
    });
    expect(await getSessionStateVersion(child, "main", database)).toBe(second.sequence);
  } finally {
    admission.mockRestore();
  }
});

it("preserves older readers and version markers when watcher provenance is first written", async () => {
  await seedWatcher(watcher);
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
  const pragma = (name: string) => query(`PRAGMA ${name}`).get();
  const schemaBeforeRead = pragma("schema_version");
  expect(await getSessionStateVersion(child, "main", database)).toBe(event.sequence);
  expect((await stateEvents()).map((entry) => entry.sequence)).toContain(event.sequence);
  await sweepSessionStateWatchNotices({ ...database, now });
  expect(readCursor(database)?.notified_sequence).toBe(event.sequence);
  expect(peekSystemEventEntries(watcher)).toEqual([]);
  expect(getLastHeartbeatEvent()).toMatchObject({ status: "skipped", reason: "store-replaced" });
  expect((await stateEvents()).map((entry) => entry.sequence)).not.toContain(event.sequence);
  expect(await getSessionStateVersion(child, "main", database)).toBe(event.sequence);
  expect(pragma("schema_version")).toEqual(schemaBeforeRead);
  expect(
    query(
      "SELECT name FROM pragma_table_info('session_watch_cursors') WHERE name = 'watcher_store_path'",
    ).get(),
  ).toBeUndefined();

  await seedChild(database, nestedWatcher);
  assertSqliteSchemaContains(
    requireNativeSqliteDatabase(reopened.db),
    reopened.path,
    getOpenClawStateRuntimeSchema({ includeVersionLazyAdditiveTables: false }).replace(
      /^ {2}(?:watcher_store_path|requester_store_path|controller_store_path) TEXT,\n/gm,
      "",
    ),
    STATE_RUNTIME_SCHEMA_COMPATIBILITY,
  );
  query(
    "INSERT INTO session_watch_cursors (watcher_session_key, target_session_key, updated_at) VALUES (?, ?, ?)",
  ).run(watcher, "legacy-target", Date.now());
  expect(
    query(
      "SELECT last_seen_sequence, watcher_store_path FROM session_watch_cursors WHERE target_session_key = 'legacy-target'",
    ).get(),
  ).toEqual({ last_seen_sequence: 0, watcher_store_path: null });
  const installedSchema = pragma("schema_version");
  await recordSessionStateEventAsync(eventInput(), database);
  expect([pragma("schema_version"), pragma("user_version")]).toEqual([
    installedSchema,
    userVersion,
  ]);
});

it("discovers a cold custom watcher store without caller-thread SQL", async () => {
  const storePath = path.join(database.env.OPENCLAW_STATE_DIR, "custom", "sessions.json");
  const cfg = { session: { store: storePath } };
  await seedWatcher(watcher, storePath, 1);
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
    await recordSessionCreated(cfg, { ...creation("custom-created"), agentId: "main" });
    expect(sql.count()).toBe(0);
    expect(
      await registerSessionStateWatch(
        { watcherSessionKey: watcher, targetSessionKey: child },
        database,
      ),
    ).toBe(true);
    expect(sql.count()).toBe(0);
    expect(await groupWatch("agent:main:telegram:group:custom")).toBe(true);
    expect(sql.count()).toBe(0);
  } finally {
    sql.restore();
  }
  expect(query("SELECT DISTINCT watcher_store_path FROM session_watch_cursors").all()).toEqual([
    { watcher_store_path: path.join(path.dirname(storePath), "openclaw-agent.sqlite") },
  ]);
});

it("retains the creation database while notice preparation yields", async () => {
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
  const recording = recordSessionCreated({}, creation("original-store"));
  await entered.promise;
  const replacement = createDatabaseOptions();
  prepared.resolve(storePath);
  await recording;
  expect(await stateEvents()).toMatchObject([{ kind: "created", sessionId: "original-store" }]);
  expect(await stateEvents(replacement)).toEqual([]);
});

it.each([
  { handoff: "a replacement store", replaced: true },
  { handoff: "a same-store resolver", replaced: false },
])(
  "preserves consumed notice custody across $handoff while acknowledgment waits",
  async ({ replaced }) => {
    const originalStore = watcherStore();
    let currentStore = originalStore;
    publishSystemEventStoreResolver(() => currentStore);
    expect(await watch()).toBe(true);
    await recordSessionStateEventAsync(eventInput({ watcherSessionKeys: [] }), database);
    const before = replaced ? readCursor(database, nestedWatcher) : undefined;
    if (!replaced) {
      enqueueSystemEvent("ordinary queued event", { sessionKey: nestedWatcher });
    }
    const { entered, release, blocking } = holdWorker();
    let draining: Promise<string | undefined> | undefined;
    try {
      await entered.promise;
      draining = drain(nestedWatcher);
      expect(peekSystemEventEntries(nestedWatcher)).toHaveLength(0);
      if (replaced) {
        currentStore = `${originalStore}.replacement`;
        openOpenClawStateDatabase(database)
          .db.prepare(
            "UPDATE session_watch_cursors SET watcher_store_path = ? WHERE watcher_session_key = ?",
          )
          .run(currentStore, nestedWatcher);
      } else {
        publishSystemEventStoreResolver(() => currentStore);
      }
      release.resolve();
      await blocking;
      const formatted = await draining;
      if (replaced) {
        expect(formatted).toBeUndefined();
        expect(readCursor(database, nestedWatcher)).toEqual(before);
        expect(peekSystemEventEntries(nestedWatcher)).toHaveLength(0);
      } else {
        expect(formatted).toContain("ordinary queued event");
        expect(formatted).toContain(`Session "${child}" changed`);
      }
    } finally {
      release.resolve();
      await blocking;
      await draining;
    }
  },
);

it("restores explicit watcher notices as ordinary-turn context without starting replay turns", async () => {
  const watchers = ["agent:main:dashboard:restored-a", "agent:main:dashboard:restored-b"];
  const storePath = resolvePhysicalSessionStorePath({ sessionKey: watchers[0], env: database.env });
  publishSystemEventStoreResolver(() => storePath);
  for (const sessionKey of watchers) {
    await seedWatcher(sessionKey, undefined, 1);
    insertCursor(sessionKey, child, storePath);
  }
  resetSystemEventsForTest();
  const capture = vi.spyOn(sessionEvents, "captureSessionEventTargetForHost");
  await sweepSessionStateWatchNotices(database);
  await sweepSessionStateWatchNotices(database);
  expect(capture).not.toHaveBeenCalled();
  for (const sessionKey of watchers) {
    expect(peekSystemEventEntries(sessionKey)).toHaveLength(1);
    expectCursor([1, 3, 3], sessionKey);
    expect(await drain(sessionKey)).toContain(`Session "${child}" changed (other actor)`);
    expect(readCursor(database, sessionKey)?.last_seen_sequence).toBe(3);
  }
  await sweepSessionStateWatchNotices(database);
  for (const sessionKey of watchers) {
    expect(peekSystemEventEntries(sessionKey)).toEqual([]);
  }
  expect(capture).not.toHaveBeenCalled();
});

it("rechecks acknowledged, rebound, and advanced cursors after sweep discovery", async ({
  signal,
}) => {
  await seedWatcher(nestedWatcher, undefined, 1);
  const storePath = watcherStore();
  publishSystemEventStoreResolver(() => storePath);
  const acked = `${child}-acked`;
  const rebound = `${child}-rebound`;
  const advanced = `${child}-advanced`;
  for (const target of [acked, rebound, advanced]) {
    insertCursor(nestedWatcher, target, storePath);
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
    await acknowledge(acked, storePath);
    query(
      `UPDATE session_watch_cursors
       SET watcher_store_path = ?, last_seen_sequence = 5,
           notified_sequence = 11, material_sequence = 13
       WHERE watcher_session_key = ? AND target_session_key = ?`,
    ).run(`${storePath}.replacement`, nestedWatcher, rebound);
    query(
      `UPDATE session_watch_cursors SET material_sequence = 7
       WHERE watcher_session_key = ? AND target_session_key = ?`,
    ).run(nestedWatcher, advanced);
    release.resolve();
    await sweeping;

    expectCursor([3, 3, 3], nestedWatcher, acked);
    expectCursor([5, 11, 13], nestedWatcher, rebound);
    expectCursor([1, 7, 7], nestedWatcher, advanced);
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
  const group = "agent:main:telegram:group:worker-boundary";
  const globalEvent = (agentId: string, summary = "human message via test") =>
    record({ sessionKey: "global", watcherSessionKeys: [], agentId, summary });
  const events = await Promise.all(
    Array.from({ length: 201 }, async (_, index) => globalEvent("main", `main event ${index}`)),
  );
  const mainHead = expectDefined(events.at(-1), "main head");
  const opsHead = await globalEvent("ops");
  const constructorHead = await globalEvent("constructor");
  const sql = observeMainThreadSql();
  const measure = async <T>(label: string, operation: () => T | Promise<T>): Promise<T> => {
    sql.clear();
    const result = await operation();
    expect.soft(sql.count(), label).toBe(0);
    return result;
  };
  try {
    sql.calibrate();
    for (const [agentId, head] of [
      ["main", mainHead],
      ["constructor", constructorHead],
    ] as const) {
      expect(
        await measure(`${agentId} version`, () =>
          getSessionStateVersion("global", agentId, database),
        ),
      ).toBe(head.sequence);
    }
    const targets = ["main", "ops", "constructor"].map((agentId) => ({
      agentId,
      sessionKey: "global",
    }));
    expect(
      await measure("composite session versions", () => getSessionStateVersions(targets, database)),
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
    expect(page).toMatchObject({ truncated: true, historyGap: false });

    expect(await measure("explicit watch registration", () => watch())).toBe(true);
    const frozen = await record({ watcherSessionKeys: [] });
    const interleaved = await record({ watcherSessionKeys: [] });
    const watcherStorePath = peekSystemEventEntries(nestedWatcher)[0]?.sessionStorePath ?? null;
    await measure("explicit watch acknowledgment", () => acknowledge(child, watcherStorePath));
    expectCursor([frozen.sequence, interleaved.sequence, interleaved.sequence]);

    for (const label of ["initial group watch", "existing group watch"]) {
      expect(await measure(label, () => groupWatch(group))).toBe(true);
    }
    const groupFrozen = await record({ sessionKey: group, watcherSessionKeys: [] });
    const groupInterleaved = await record({ sessionKey: group, watcherSessionKeys: [] });
    expect(peekSystemEventEntries(watcher)).toHaveLength(1);
    expect(await measure("system-event drain acknowledgment", () => drain(watcher))).toContain(
      `Session "${group}" changed`,
    );
    expectCursor(
      [groupFrozen.sequence, groupInterleaved.sequence, groupInterleaved.sequence],
      watcher,
      group,
    );
    expect(peekSystemEventEntries(watcher)).toHaveLength(1);
    expect(peekSystemEventEntries(watcher)[0]?.text).toContain(
      `changesSince ${groupFrozen.sequence}`,
    );
  } finally {
    sql.restore();
  }
});

it("reconstructs a committed followup when acknowledgment publication is lost", async () => {
  await seedWatcher();
  expect(await watch()).toBe(true);
  const frozen = await record({ watcherSessionKeys: [] });
  const newer = await record({ watcherSessionKeys: [] });
  const originalNotice = expectDefined(peekSystemEventEntries(nestedWatcher)[0], "original notice");
  resetSystemEventsForTest();
  const publish = vi.fn(() => {
    throw new Error("Publication lost after commit");
  });
  await acknowledgeSessionStateNoticesInWorker(
    nestedWatcher,
    [{ targetSessionKey: child, watcherStorePath: originalNotice.sessionStorePath ?? null }],
    publish,
    database,
  );
  expect(publish).toHaveBeenCalledOnce();
  expect(peekSystemEventEntries(nestedWatcher)).toEqual([]);
  expectCursor([frozen.sequence, newer.sequence, newer.sequence]);
  await sweepSessionStateWatchNotices(database);
  expect(peekSystemEventEntries(nestedWatcher).map(({ text }) => text)).toEqual([
    expect.stringContaining(`changesSince ${frozen.sequence}`),
  ]);
  expectCursor([frozen.sequence, newer.sequence, newer.sequence]);
});

it("rolls back watch writes when the system-event store changes at transaction or commit admission", async () => {
  const originalStore = watcherStore();
  let currentStore = originalStore;
  publishSystemEventStoreResolver(() => currentStore);
  for (const operation of ["register", "acknowledge", "spawn"] as const) {
    for (const stage of ["transaction", "commit"] as const) {
      currentStore = originalStore;
      const targetSessionKey = `${child}-${operation}-${stage}`;
      if (operation === "acknowledge") {
        expect(await watch(targetSessionKey)).toBe(true);
        for (let index = 0; index < 2; index++) {
          await record({ sessionKey: targetSessionKey, watcherSessionKeys: [] });
        }
      }
      const before = readCursor(database, nestedWatcher, targetSessionKey);
      const notice = vi.spyOn(notices, "enqueueSessionStateNotice");
      let witnessed = false;
      const admission = probe.admission(workerAdmission, (request, grant, admit) => {
        if (request.stage === stage) {
          witnessed = true;
          currentStore = `${originalStore}.replacement`;
        }
        admit(request, grant);
      });
      try {
        if (operation === "register") {
          expect(await watch(targetSessionKey)).toBe(false);
        } else if (operation === "spawn") {
          await recordSubagentSpawned({
            childSessionKey: targetSessionKey,
            childRunId: `spawn-${stage}`,
            requesterSessionKey: nestedWatcher,
            agentId: "main",
          });
          expect(await getSessionStateVersion(targetSessionKey, "main", database)).toBe(0);
        } else {
          await acknowledge(targetSessionKey, originalStore);
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
  openOpenClawStateDatabase(database);
  const originalStore = watcherStore();
  publishSystemEventStoreResolver(() => originalStore);
  const replacementDiscovery = vi.fn(() => {
    throw new Error("A retired admission must not invoke replacement store discovery");
  });
  let witnessed = false;
  const admission = probe.admission(workerAdmission, (request, grant, admit) => {
    if (request.stage === "commit") {
      witnessed = true;
      publishSystemEventStoreResolver(replacementDiscovery);
    }
    admit(request, grant);
  });
  try {
    expect(await watch()).toBe(false);
    expect(witnessed).toBe(true);
    expect(replacementDiscovery).not.toHaveBeenCalled();
    expect(readCursor(database, nestedWatcher)).toBeUndefined();
  } finally {
    admission.mockRestore();
  }
});
