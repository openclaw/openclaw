import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { drainFormattedSystemEvents } from "../auto-reply/reply/session-system-events.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../config/io.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import {
  publishSystemEventStoreConfig,
  resolvePhysicalSessionStorePath,
} from "../config/sessions/session-store-path.js";
import * as workerAdmission from "../infra/sqlite-worker-operation-admission.js";
import { publishSystemEventStoreResolver } from "../infra/system-event-ownership.js";
import { enqueueSystemEvent, peekSystemEventEntries } from "../infra/system-events.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { runOpenClawStateWorkerOperation } from "../state/openclaw-state-worker-store.js";
import { observeMainThreadSql } from "../test-utils/main-thread-sql-spies.test-support.js";
import { recordSessionCreated } from "./session-created.js";
import {
  acknowledgeSessionStateNotices,
  getSessionStateVersion,
  getSessionStateVersions,
  listSessionStateEventsSince,
  recordSessionStateEvent,
  recordSessionCompacted,
  recordSubagentSpawned,
  registerMainSessionGroupWatch,
  registerSessionStateWatch,
} from "./session-state-events.js";
import {
  child,
  cleanupSessionStateTestState,
  createDatabaseOptions,
  eventInput,
  nestedWatcher,
  readCursor,
  watcher,
} from "./session-state-events.test-support.js";
import * as notices from "./session-state-notices.js";

afterEach(async () => {
  vi.restoreAllMocks();
  publishSystemEventStoreResolver(undefined);
  clearRuntimeConfigSnapshot();
  await cleanupSessionStateTestState();
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
  recordSessionStateEvent(eventInput({ watcherSessionKeys: [] }), database);
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
  recordSessionStateEvent(eventInput({ watcherSessionKeys: [] }), database);
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

it("reads session state and commits watch registration and acknowledgment without caller-thread SQL", async () => {
  const database = createDatabaseOptions();
  const group = "agent:main:telegram:group:worker-boundary";
  const events = Array.from({ length: 201 }, (_, index) =>
    expectDefined(
      recordSessionStateEvent(
        eventInput({
          sessionKey: "global",
          watcherSessionKeys: [],
          summary: `main event ${index}`,
        }),
        database,
      ),
      "seeded main event",
    ),
  );
  const mainHead = expectDefined(events.at(-1), "main head");
  const opsHead = expectDefined(
    recordSessionStateEvent(
      eventInput({ sessionKey: "global", agentId: "ops", watcherSessionKeys: [] }),
      database,
    ),
    "seeded ops event",
  );
  const constructorHead = expectDefined(
    recordSessionStateEvent(
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
      recordSessionStateEvent(eventInput({ watcherSessionKeys: [] }), database),
      "frozen child notification",
    );
    const interleaved = expectDefined(
      recordSessionStateEvent(eventInput({ watcherSessionKeys: [] }), database),
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
      recordSessionStateEvent(eventInput({ sessionKey: group, watcherSessionKeys: [] }), database),
      "frozen group notification",
    );
    const groupInterleaved = expectDefined(
      recordSessionStateEvent(eventInput({ sessionKey: group, watcherSessionKeys: [] }), database),
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
          recordSessionStateEvent(
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
