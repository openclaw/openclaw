import { afterEach, describe, expect, it, vi } from "vitest";
import { trackSqliteStatementExecutions } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { drainFormattedSystemEvents } from "../auto-reply/reply/session-system-events.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getLastHeartbeatEvent, resetHeartbeatEventsForTest } from "../infra/heartbeat-events.js";
import { requestHeartbeat, setHeartbeatWakeHandler } from "../infra/heartbeat-wake.js";
import { assertSqliteSchemaContains } from "../infra/sqlite-schema-contract.js";
import {
  enqueueSystemEvent,
  peekSystemEventEntries,
  resetSystemEventsForTest,
} from "../infra/system-events.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import {
  getOpenClawStateRuntimeSchema,
  STATE_PERSISTENT_SCHEMA_COMPATIBILITY,
} from "../state/openclaw-state-schema-compatibility.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { recordSessionCreated } from "./session-created.js";
import {
  acknowledgeSessionStateNotices,
  classifySessionStateActor,
  getSessionStateVersion,
  handleSessionStateSessionDeleted,
  handleSessionStateSessionReset,
  listAmbientGroupWatchTargets,
  listSessionStateEventsSince,
  recordSessionCompacted,
  recordSessionGoalChanged,
  recordSessionHumanDirectMessage,
  recordSessionStateEvent,
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
import { recordSubagentTerminalState } from "./subagent-terminal-state.js";

const SESSION_STATE_MAX_ROWS = 50_000;
const SESSION_STATE_RETENTION_MS = 30 * 24 * 60 * 60_000;
const group = "agent:main:telegram:group:room-1";
const cfg = {} as OpenClawConfig;
let disposeHeartbeatWakeHandler: (() => void) | undefined;

async function createWatcherSession(
  database: ReturnType<typeof createDatabaseOptions>,
  watcherSessionKey = watcher,
) {
  await upsertSessionEntryCore(
    { sessionKey: watcherSessionKey, env: database.env },
    { sessionId: `session-${watcherSessionKey}`, updatedAt: Date.now() },
  );
}

afterEach(async () => {
  disposeHeartbeatWakeHandler?.();
  disposeHeartbeatWakeHandler = undefined;
  await cleanupSessionStateTestState();
});

describe("session state events", () => {
  it("does not advance a replacement watch from older producer facts", () => {
    const database = createDatabaseOptions();
    resetHeartbeatEventsForTest();
    registerSessionStateWatch({ watcherSessionKey: watcher, targetSessionKey: child }, database);
    const readBinding = () =>
      openOpenClawStateDatabase(database)
        .db.prepare(
          "SELECT * FROM session_watch_cursors WHERE watcher_session_key = ? AND target_session_key = ?",
        )
        .get(watcher, child);
    const original = readBinding();
    const event = recordSessionStateEvent(
      eventInput({
        watcherStorePaths: { [watcher]: "/synthetic/retired-store.sqlite" },
      }),
      database,
    );
    expect(event?.sequence).toBeGreaterThan(0);
    expect(readBinding()).toEqual(original);
    expect(peekSystemEventEntries(watcher)).toEqual([]);
    expect(getLastHeartbeatEvent()).toMatchObject({ status: "skipped", reason: "store-replaced" });
  });
  it("preserves older readers and version markers when watcher provenance is first written", () => {
    const database = createDatabaseOptions();
    const before = openOpenClawStateDatabase(database);
    before.db.exec("ALTER TABLE session_watch_cursors DROP COLUMN watcher_store_path");
    const userVersion = before.db.prepare("PRAGMA user_version").get();
    closeOpenClawStateDatabaseForTest();
    const reopened = openOpenClawStateDatabase(database);
    const schemaBeforeRead = reopened.db.prepare("PRAGMA schema_version").get();
    expect(getSessionStateVersion(child, "main", database)).toBe(0);
    expect(reopened.db.prepare("PRAGMA schema_version").get()).toEqual(schemaBeforeRead);
    expect(
      reopened.db
        .prepare(
          "SELECT name FROM pragma_table_info('session_watch_cursors') WHERE name = 'watcher_store_path'",
        )
        .get(),
    ).toBeUndefined();

    seedChild(database);
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
    recordSessionStateEvent(eventInput(), database);
    expect(reopened.db.prepare("PRAGMA schema_version").get()).toEqual(installedSchema);
    expect(reopened.db.prepare("PRAGMA user_version").get()).toEqual(userVersion);
  });

  it("bumps a durable head that survives pruning all retained rows", () => {
    const database = createDatabaseOptions();
    const now = Date.now();
    const event = recordSessionStateEvent(eventInput(), { ...database, now });
    expect(getSessionStateVersion(child, "main", database)).toBe(event?.sequence);

    sweepSessionStateWatchNotices({
      ...database,
      now: now + SESSION_STATE_RETENTION_MS + 1,
    });

    expect(listSessionStateEventsSince(child, "main", 0, 200, database).events).toEqual([]);
    expect(getSessionStateVersion(child, "main", database)).toBe(event?.sequence);
  });

  it("freezes one notice watermark while material events continue", () => {
    const database = createDatabaseOptions();
    seedChild(database);
    const first = recordSessionStateEvent(eventInput(), database)!;
    recordSessionStateEvent(eventInput(), database);
    const third = recordSessionStateEvent(eventInput(), database)!;

    expect(peekSystemEventEntries(watcher)).toHaveLength(1);
    expect(readCursor(database)).toEqual({
      last_seen_sequence: first.sequence - 1,
      notified_sequence: first.sequence,
      material_sequence: third.sequence,
    });
  });

  it("opens a fresh notice for material work interleaved before ack", () => {
    const database = createDatabaseOptions();
    seedChild(database);
    const frozen = recordSessionStateEvent(eventInput(), database)!;
    const interleaved = recordSessionStateEvent(eventInput(), database)!;
    resetSystemEventsForTest();

    acknowledgeSessionStateNotices(watcher, [child], database);

    expect(readCursor(database)).toEqual({
      last_seen_sequence: frozen.sequence,
      notified_sequence: interleaved.sequence,
      material_sequence: interleaved.sequence,
    });
    expect(peekSystemEventEntries(watcher)).toHaveLength(1);
    expect(peekSystemEventEntries(watcher)[0]?.text).toContain(`changesSince ${frozen.sequence}`);
  });

  it("does not reopen an acked notice for log-only events or during sweep", async () => {
    const database = createDatabaseOptions();
    await createWatcherSession(database);
    seedChild(database);
    const material = recordSessionStateEvent(eventInput(), database)!;
    recordSessionStateEvent(
      eventInput({ kind: "run_completed", actorType: "system", runId: "run-log-only" }),
      database,
    );
    resetSystemEventsForTest();

    acknowledgeSessionStateNotices(watcher, [child], database);
    expect(readCursor(database)).toEqual({
      last_seen_sequence: material.sequence,
      notified_sequence: material.sequence,
      material_sequence: material.sequence,
    });
    expect(peekSystemEventEntries(watcher)).toEqual([]);

    sweepSessionStateWatchNotices(database);
    expect(peekSystemEventEntries(watcher)).toEqual([]);
  });

  it("wakes main watchers but only queues nested notices after a prior clock", async () => {
    vi.useFakeTimers();
    vi.advanceTimersByTime(30_000);
    requestHeartbeat({
      source: "exec-event",
      intent: "event",
      reason: "exec-event",
      coalesceMs: 0,
    });
    vi.useRealTimers();
    vi.useFakeTimers();
    const wakes = vi.fn(async () => ({ status: "ran" as const, durationMs: 1 }));
    disposeHeartbeatWakeHandler = setHeartbeatWakeHandler(wakes);
    // Pending deadlines may belong to a previous fake-clock origin.
    await vi.runAllTimersAsync();
    wakes.mockClear();
    const database = createDatabaseOptions();
    seedChild(database, nestedWatcher);

    recordSessionStateEvent(eventInput({ watcherSessionKeys: [nestedWatcher] }), database);
    await vi.advanceTimersByTimeAsync(21_000);
    expect(peekSystemEventEntries(nestedWatcher)).toHaveLength(1);
    expect(wakes).not.toHaveBeenCalled();

    seedChild(database, watcher);
    recordSessionStateEvent(eventInput(), database);
    await vi.advanceTimersByTimeAsync(21_000);
    expect(wakes).toHaveBeenCalledWith(
      // intent "immediate" is load-bearing: event-intent wakes defer on heartbeat
      // dueness and would sit on the notice until the next scheduled tick. The
      // wake itself coalesces for SESSION_STATE_WAKE_COALESCE_MS (20s), hence
      // the 21s timer advances in these tests.
      expect.objectContaining({
        source: "session-state",
        sessionKey: watcher,
        intent: "immediate",
      }),
    );
  });

  it("suppresses watcher-originated material events", () => {
    const database = createDatabaseOptions();
    const seeded = seedChild(database)!;
    recordSessionStateEvent(eventInput({ actorType: "agent", actorId: watcher }), database);

    expect(readCursor(database)).toEqual({
      last_seen_sequence: seeded.sequence,
      notified_sequence: seeded.sequence,
      material_sequence: seeded.sequence,
    });
    expect(peekSystemEventEntries(watcher)).toEqual([]);
  });

  it("records log-only kinds without queueing notices", () => {
    const database = createDatabaseOptions();
    const event = recordSessionStateEvent(
      eventInput({ kind: "compacted", actorType: "system" }),
      database,
    );

    expect(getSessionStateVersion(child, "main", database)).toBe(event?.sequence);
    expect(peekSystemEventEntries(watcher)).toEqual([]);
  });

  it("notifies watchers when an upstream session disappears", () => {
    const database = createDatabaseOptions();
    seedChild(database);
    resetSystemEventsForTest();

    const event = recordSessionStateEvent(
      eventInput({ kind: "upstream_missing", actorType: "system" }),
      database,
    );

    expect(event).toMatchObject({ kind: "upstream_missing", actorType: "system" });
    expect(peekSystemEventEntries(watcher)).toHaveLength(1);
  });

  it("returns the existing row for a duplicate dedupe key", () => {
    const database = createDatabaseOptions();
    const input = eventInput({
      kind: "run_failed",
      actorType: "system",
      runId: "run-1",
      dedupeKey: "run-terminal:run-1",
    });
    const first = recordSessionStateEvent(input, database);
    const duplicate = recordSessionStateEvent(input, database);

    expect(duplicate?.sequence).toBe(first?.sequence);
    expect(listSessionStateEventsSince(child, "main", 0, 200, database).events).toHaveLength(1);
  });

  it("re-enqueues and re-freezes pending notices after restart", async () => {
    const database = createDatabaseOptions();
    await createWatcherSession(database);
    seedChild(database);
    const material = recordSessionStateEvent(eventInput(), database)!;
    resetSystemEventsForTest();

    sweepSessionStateWatchNotices(database);

    expect(peekSystemEventEntries(watcher)).toHaveLength(1);
    expect(readCursor(database)?.notified_sequence).toBe(material.sequence);
  });

  it("self-heals a lost queued notice on the next material event", () => {
    const database = createDatabaseOptions();
    seedChild(database);
    recordSessionStateEvent(eventInput(), database);
    resetSystemEventsForTest();

    recordSessionStateEvent(eventInput(), database);

    expect(peekSystemEventEntries(watcher)).toHaveLength(1);
  });

  it("prunes retention and cap rows while keeping monotonic autoincrement heads", () => {
    const database = createDatabaseOptions();
    const now = Date.now();
    const { db } = openOpenClawStateDatabase(database);
    db.exec(`
      WITH RECURSIVE rows(value) AS (
        SELECT 1 UNION ALL SELECT value + 1 FROM rows WHERE value <= ${SESSION_STATE_MAX_ROWS}
      )
      INSERT INTO session_state_events (
        session_key, agent_id, kind, actor_type, occurred_at, summary
      )
      SELECT 'bulk', 'main', 'compacted', 'system', ${now}, 'bulk' FROM rows;
    `);
    const before = db
      .prepare("SELECT max(sequence) AS sequence FROM session_state_events")
      .get() as { sequence: number };

    sweepSessionStateWatchNotices({ ...database, now });
    const count = db.prepare("SELECT count(*) AS count FROM session_state_events").get() as {
      count: number;
    };
    expect(count.count).toBe(SESSION_STATE_MAX_ROWS);

    const next = recordSessionStateEvent(eventInput(), { ...database, now: now + 1 })!;
    expect(next.sequence).toBeGreaterThan(before.sequence);
    expect(getSessionStateVersion(child, "main", database)).toBe(next.sequence);
  });

  it("prunes many composite session heads without recreating or regressing them", () => {
    const database = createDatabaseOptions();
    const { db } = openOpenClawStateDatabase(database);
    const now = SESSION_STATE_RETENTION_MS + 100;
    const insertEvent = db.prepare(`
      INSERT INTO session_state_events
        (session_key, agent_id, kind, actor_type, occurred_at, summary)
      VALUES (?, ?, 'compacted', 'system', 1, 'old')
    `);
    const insertHead = db.prepare(`
      INSERT INTO session_state_heads
        (session_key, agent_id, last_sequence, pruned_max_sequence, updated_at)
      VALUES (?, ?, 1000000, ?, 7)
    `);
    const expected: Array<{
      session_key: string;
      agent_id: string;
      last_sequence: number;
      pruned_max_sequence: number;
      updated_at: number;
    }> = [];
    for (let index = 0; index < 257; index += 1) {
      const sessionKey = `shared-${Math.floor(index / 2)}`;
      const agentId = index % 2 === 0 ? "main" : "ops";
      insertEvent.run(sessionKey, agentId);
      const sequence = Number(insertEvent.run(sessionKey, agentId).lastInsertRowid);
      if (index % 17 === 0) {
        continue;
      }
      const previous = index % 4 === 0 ? 900000 : index % 4 === 1 ? sequence : 0;
      insertHead.run(sessionKey, agentId, previous);
      expected.push({
        session_key: sessionKey,
        agent_id: agentId,
        last_sequence: 1000000,
        pruned_max_sequence: Math.max(previous, sequence),
        updated_at: previous < sequence ? now : 7,
      });
    }

    db.exec(`
      INSERT INTO session_state_events
        (session_key, agent_id, kind, actor_type, occurred_at, summary)
      VALUES (CAST(X'81' AS TEXT), 'main', 'compacted', 'system', 1, 'first'),
             (CAST(X'80' AS TEXT), 'main', 'compacted', 'system', 1, 'second');
    `);
    insertHead.run("\ufffd", "main", 0);
    expected.push({
      session_key: "\ufffd",
      agent_id: "main",
      last_sequence: 1000000,
      pruned_max_sequence: 516,
      updated_at: now,
    });

    const updates = trackSqliteStatementExecutions(db, ["watermarks"], (sql) =>
      /\bupdate\s+"?session_state_heads"?\b/i.test(sql) ? "watermarks" : null,
    );
    try {
      sweepSessionStateWatchNotices({ ...database, now });
    } finally {
      updates.restore();
    }

    const heads = db.prepare("SELECT * FROM session_state_heads").all();
    expect(heads).toHaveLength(expected.length);
    expect(heads).toEqual(expect.arrayContaining(expected));
    expect(db.prepare("SELECT count(*) AS count FROM session_state_events").get()).toEqual({
      count: 0,
    });
    closeOpenClawStateDatabaseForTest();
    expect(
      openOpenClawStateDatabase(database).db.prepare("SELECT * FROM session_state_heads").all(),
    ).toEqual(heads);
    expect(updates.counts.watermarks).toBeGreaterThan(0);
    expect(updates.counts.watermarks).toBeLessThanOrEqual(4);
  });

  it("lists typed ascending deltas with truncation and history-gap signaling", () => {
    const database = createDatabaseOptions();
    const now = Date.now();
    const first = recordSessionStateEvent(eventInput({ summary: "first" }), {
      ...database,
      now,
    })!;
    recordSessionStateEvent(eventInput({ summary: "second", payload: { status: "active" } }), {
      ...database,
      now: now + 1,
    });
    recordSessionStateEvent(eventInput({ summary: "third" }), { ...database, now: now + 2 });

    const page = listSessionStateEventsSince(child, "main", 0, 2, database);
    expect(page.events.map((event) => event.summary)).toEqual(["first", "second"]);
    expect(page.events[1]?.payload).toEqual({ status: "active" });
    expect(page.truncated).toBe(true);

    // A manually removed row is not a retention gap: only pruning stamps the
    // per-session watermark that historyGap may consult.
    openOpenClawStateDatabase(database)
      .db.prepare("DELETE FROM session_state_events WHERE sequence = ?")
      .run(first.sequence);
    expect(listSessionStateEventsSince(child, "main", 0, 200, database).historyGap).toBe(false);
  });

  it("reports history gaps only for actually pruned events, not sparse global sequences", () => {
    const database = createDatabaseOptions();
    const now = Date.now();
    // Other sessions consume early global sequences; the child starts high.
    for (let index = 0; index < 3; index += 1) {
      recordSessionStateEvent(
        eventInput({ sessionKey: "agent:main:subagent:noise", watcherSessionKeys: [] }),
        { ...database, now },
      );
    }
    const old = recordSessionStateEvent(eventInput({ summary: "old" }), { ...database, now })!;
    expect(old.sequence).toBeGreaterThan(1);
    expect(listSessionStateEventsSince(child, "main", 0, 200, database).historyGap).toBe(false);

    const later = now + SESSION_STATE_RETENTION_MS + 1;
    const fresh = recordSessionStateEvent(eventInput({ summary: "fresh" }), {
      ...database,
      now: later,
    })!;
    sweepSessionStateWatchNotices({ ...database, now: later });

    const sincePruned = listSessionStateEventsSince(child, "main", 0, 200, database);
    expect(sincePruned.historyGap).toBe(true);
    expect(sincePruned.events.map((event) => event.summary)).toEqual(["fresh"]);
    expect(listSessionStateEventsSince(child, "main", old.sequence, 200, database).historyGap).toBe(
      false,
    );
    expect(getSessionStateVersion(child, "main", database)).toBe(fresh.sequence);
  });

  it("suppresses cursors and notices for agent-ambiguous bare watcher keys", () => {
    const database = createDatabaseOptions();
    const event = recordSessionStateEvent(
      eventInput({ watcherSessionKeys: ["global"] }),
      database,
    )!;
    expect(event.sequence).toBeGreaterThan(0);
    expect(peekSystemEventEntries("agent:main:global")).toEqual([]);
    const cursorRow = openOpenClawStateDatabase(database)
      .db.prepare("SELECT COUNT(*) AS n FROM session_watch_cursors")
      .get() as { n: number };
    expect(cursorRow.n).toBe(0);
  });

  it("keeps same-keyed global sessions independent across agents", () => {
    const database = createDatabaseOptions();
    const mainEvent = recordSessionStateEvent(
      eventInput({
        sessionKey: "global",
        agentId: "main",
        kind: "goal_changed",
        actorType: "human",
        watcherSessionKeys: [],
      }),
      database,
    )!;
    const opsEvent = recordSessionStateEvent(
      eventInput({
        sessionKey: "global",
        agentId: "ops",
        kind: "goal_changed",
        actorType: "human",
        watcherSessionKeys: [],
      }),
      database,
    )!;

    expect(getSessionStateVersion("global", "main", database)).toBe(mainEvent.sequence);
    expect(getSessionStateVersion("global", "ops", database)).toBe(opsEvent.sequence);
    expect(
      listSessionStateEventsSince("global", "main", 0, 200, database).events.map(
        (event) => event.sequence,
      ),
    ).toEqual([mainEvent.sequence]);

    handleSessionStateSessionDeleted("global", "ops", database);
    expect(getSessionStateVersion("global", "ops", database)).toBe(0);
    expect(getSessionStateVersion("global", "main", database)).toBe(mainEvent.sequence);
  });

  it("acks only drained session-state entries and ignores ordinary events", async () => {
    const database = createDatabaseOptions();
    seedChild(database);
    const material = recordSessionStateEvent(eventInput(), database)!;
    enqueueSystemEvent("Cron completed", { sessionKey: watcher, contextKey: "cron:job-1" });

    await drainFormattedSystemEvents({
      cfg,
      agentId: "main",
      sessionKey: watcher,
      isMainSession: false,
      isNewSession: false,
    });
    expect(readCursor(database)?.last_seen_sequence).toBe(material.sequence);

    recordSessionStateEvent(eventInput(), database);
    resetSystemEventsForTest();
    enqueueSystemEvent("Exec completed", { sessionKey: watcher, contextKey: "exec:job-1" });
    await drainFormattedSystemEvents({
      cfg,
      agentId: "main",
      sessionKey: watcher,
      isMainSession: false,
      isNewSession: false,
    });
    expect(readCursor(database)?.last_seen_sequence).toBe(material.sequence);
  });

  it("keeps target history on reset and removes all ownership on delete", () => {
    const database = createDatabaseOptions();
    seedChild(database);
    recordSessionStateEvent(eventInput(), database);

    handleSessionStateSessionReset(watcher, database);
    expect(readCursor(database)).toBeUndefined();
    expect(
      listSessionStateEventsSince(child, "main", 0, 200, database).events.length,
    ).toBeGreaterThan(0);

    handleSessionStateSessionDeleted(child, "main", database);
    expect(getSessionStateVersion(child, "main", database)).toBe(0);
    expect(listSessionStateEventsSince(child, "main", 0, 200, database).events).toEqual([]);
  });

  it("classifies missing provenance as human and inter-session provenance as agent", () => {
    expect(classifySessionStateActor({})).toEqual({ actorType: "human" });
    expect(
      classifySessionStateActor({
        inputProvenance: {
          kind: "inter_session",
          sourceSessionKey: "agent:main:source",
        },
      }),
    ).toEqual({ actorType: "agent", actorId: "agent:main:source" });
    expect(classifySessionStateActor({ internalEvents: [{}] })).toEqual({
      actorType: "system",
    });
  });

  it("registers explicit watchers who get notices only for later changes", () => {
    const database = createDatabaseOptions();
    const preRegistration = recordSessionStateEvent(
      eventInput({ watcherSessionKeys: [] }),
      database,
    )!;

    expect(registerSessionStateWatch({ watcherSessionKey: child, targetSessionKey: child })).toBe(
      false,
    );
    expect(
      registerSessionStateWatch({ watcherSessionKey: "global", targetSessionKey: child }),
    ).toBe(false);
    expect(
      registerSessionStateWatch({ watcherSessionKey: watcher, targetSessionKey: child }, database),
    ).toBe(true);

    expect(peekSystemEventEntries(watcher)).toHaveLength(0);
    expect(readCursor(database)).toMatchObject({ last_seen_sequence: preRegistration.sequence });

    const afterRegistration = recordSessionStateEvent(
      eventInput({ watcherSessionKeys: [] }),
      database,
    )!;
    expect(peekSystemEventEntries(watcher)).toHaveLength(1);
    expect(peekSystemEventEntries(watcher)[0]?.text).toContain(
      `changesSince ${preRegistration.sequence}`,
    );

    // Re-registering must keep the pending-notice cursor intact.
    expect(
      registerSessionStateWatch({ watcherSessionKey: watcher, targetSessionKey: child }, database),
    ).toBe(true);
    expect(readCursor(database)).toEqual({
      last_seen_sequence: preRegistration.sequence,
      notified_sequence: afterRegistration.sequence,
      material_sequence: afterRegistration.sequence,
    });
  });

  it.each(["ambient", "explicit"])("rebinds a replaced %s watch on the next group turn", (kind) => {
    const database = createDatabaseOptions();
    if (kind === "explicit") {
      registerSessionStateWatch({ watcherSessionKey: watcher, targetSessionKey: group }, database);
    } else {
      registerMainSessionGroupWatch({ sessionKey: group, agentId: "main" }, database);
    }
    const { db } = openOpenClawStateDatabase(database);
    db.prepare("UPDATE session_watch_cursors SET watcher_store_path = ?").run(
      "/retired/store.sqlite",
    );
    expect(registerMainSessionGroupWatch({ sessionKey: group, agentId: "main" }, database)).toBe(
      true,
    );
    expect(
      db.prepare("SELECT watcher_store_path, provenance FROM session_watch_cursors").get(),
    ).toEqual({
      watcher_store_path: expect.not.stringContaining("/retired/"),
      provenance: "ambient-group",
    });
    recordSessionStateEvent(eventInput({ sessionKey: group, watcherSessionKeys: [] }), database);
    expect(peekSystemEventEntries(watcher)).toHaveLength(1);
  });

  it("registers one ambient main watcher for a distinct group session", () => {
    const database = createDatabaseOptions();
    expect(
      registerMainSessionGroupWatch(
        { sessionKey: group, agentId: "main" },
        { ...database, now: 100 },
      ),
    ).toBe(true);
    expect(
      registerMainSessionGroupWatch(
        { sessionKey: group, agentId: "main" },
        { ...database, now: 200 },
      ),
    ).toBe(true);
    const rows = openOpenClawStateDatabase(database)
      .db.prepare(
        `SELECT watcher_session_key, target_session_key, provenance, updated_at
         FROM session_watch_cursors
         WHERE watcher_session_key = ?`,
      )
      .all(watcher);
    expect(rows).toEqual([
      {
        watcher_session_key: watcher,
        target_session_key: group,
        provenance: "ambient-group",
        updated_at: 100,
      },
    ]);
    expect(listAmbientGroupWatchTargets(watcher, database)).toEqual(new Set([group]));
    openOpenClawStateDatabase(database)
      .db.prepare(
        `DELETE FROM session_watch_cursors
         WHERE watcher_session_key = ? AND target_session_key = ?`,
      )
      .run(watcher, group);
    expect(listAmbientGroupWatchTargets(watcher, database)).toEqual(new Set());
  });

  it("does not register a group routed into the configured main session", () => {
    const database = createDatabaseOptions();
    const mainSessionKey = "agent:main:work";

    expect(
      registerMainSessionGroupWatch(
        {
          sessionKey: mainSessionKey,
          agentId: "main",
          mainKey: "work",
          entry: { sessionId: "session-main", updatedAt: 100, chatType: "group" },
        },
        database,
      ),
    ).toBe(false);
    expect(listAmbientGroupWatchTargets(mainSessionKey, database)).toEqual(new Set());
  });

  it("records and coalesces group activity without an immediate wake", async () => {
    vi.useFakeTimers();
    const wakes = vi.fn(async () => ({ status: "ran" as const, durationMs: 1 }));
    disposeHeartbeatWakeHandler = setHeartbeatWakeHandler(wakes);
    await vi.runAllTimersAsync();
    wakes.mockClear();
    const database = createDatabaseOptions();
    registerMainSessionGroupWatch({ sessionKey: group, agentId: "main" }, database);

    for (const actorId of ["human-1", "human-2"]) {
      await recordSessionHumanDirectMessage(
        {
          sessionKey: group,
          entry: { sessionId: "session-group", updatedAt: Date.now(), chatType: "group" },
          agentId: "main",
          actor: { actorType: "human", actorId },
          channel: "telegram",
        },
        database,
      );
    }
    await vi.advanceTimersByTimeAsync(21_000);

    expect(listSessionStateEventsSince(group, "main", 0, 200, database).events).toHaveLength(2);
    expect(peekSystemEventEntries(watcher)).toHaveLength(1);
    const cursor = readCursor(database, watcher, group);
    expect(cursor).toBeDefined();
    expect(cursor!.material_sequence).toBeGreaterThan(cursor!.notified_sequence);
    expect(wakes).not.toHaveBeenCalled();
  });

  it("prunes dormant ambient cursors while retaining active cursors", async () => {
    const database = createDatabaseOptions();
    const dormantGroup = "agent:main:slack:channel:dormant";
    const registeredAt = 100;
    registerMainSessionGroupWatch(
      { sessionKey: group, agentId: "main" },
      { ...database, now: registeredAt },
    );
    registerMainSessionGroupWatch(
      { sessionKey: dormantGroup, agentId: "main" },
      { ...database, now: registeredAt },
    );

    const activeAt = registeredAt + SESSION_STATE_RETENTION_MS + 1;
    await recordSessionHumanDirectMessage(
      {
        sessionKey: group,
        entry: { sessionId: "session-group", updatedAt: activeAt, chatType: "group" },
        agentId: "main",
        actor: { actorType: "human", actorId: "human-1" },
        channel: "telegram",
      },
      { ...database, now: activeAt },
    );
    sweepSessionStateWatchNotices({ ...database, now: activeAt });

    expect(listAmbientGroupWatchTargets(watcher, database)).toEqual(new Set([group]));
    const cursors = openOpenClawStateDatabase(database)
      .db.prepare("SELECT COUNT(*) AS count FROM session_watch_cursors")
      .get() as { count: number };
    expect(cursors.count).toBe(1);
  });

  it("keeps explicit A2A group watches on the immediate wake path", async () => {
    vi.useFakeTimers();
    const wakes = vi.fn(async () => ({ status: "ran" as const, durationMs: 1 }));
    disposeHeartbeatWakeHandler = setHeartbeatWakeHandler(wakes);
    await vi.runAllTimersAsync();
    wakes.mockClear();
    const database = createDatabaseOptions();
    const coordinator = "agent:main:coordinator";
    registerSessionStateWatch(
      { watcherSessionKey: coordinator, targetSessionKey: group },
      database,
    );

    await recordSessionHumanDirectMessage(
      {
        sessionKey: group,
        entry: { sessionId: "session-group", updatedAt: Date.now(), chatType: "group" },
        agentId: "main",
        actor: { actorType: "human", actorId: "human-1" },
        channel: "telegram",
      },
      database,
    );
    await vi.advanceTimersByTimeAsync(21_000);

    expect(peekSystemEventEntries(coordinator)).toHaveLength(1);
    expect(wakes).toHaveBeenCalledTimes(1);
  });

  it("promotes an ambient main-to-group watch to explicit immediate delivery", async () => {
    vi.useFakeTimers();
    const wakes = vi.fn(async () => ({ status: "ran" as const, durationMs: 1 }));
    disposeHeartbeatWakeHandler = setHeartbeatWakeHandler(wakes);
    await vi.runAllTimersAsync();
    wakes.mockClear();
    const database = createDatabaseOptions();
    registerMainSessionGroupWatch({ sessionKey: group, agentId: "main" }, database);
    expect(listAmbientGroupWatchTargets(watcher, database)).toEqual(new Set([group]));

    registerSessionStateWatch({ watcherSessionKey: watcher, targetSessionKey: group }, database);
    expect(listAmbientGroupWatchTargets(watcher, database)).toEqual(new Set());
    expect(
      openOpenClawStateDatabase(database)
        .db.prepare(
          `SELECT provenance FROM session_watch_cursors
           WHERE watcher_session_key = ? AND target_session_key = ?`,
        )
        .get(watcher, group),
    ).toEqual({ provenance: "explicit" });
    // Later inbound group registration must not downgrade the explicit watch.
    registerMainSessionGroupWatch({ sessionKey: group, agentId: "main" }, database);

    await recordSessionHumanDirectMessage(
      {
        sessionKey: group,
        entry: { sessionId: "session-group", updatedAt: Date.now(), chatType: "group" },
        agentId: "main",
        actor: { actorType: "human", actorId: "human-1" },
        channel: "telegram",
      },
      database,
    );
    await vi.advanceTimersByTimeAsync(21_000);

    expect(peekSystemEventEntries(watcher)).toHaveLength(1);
    expect(wakes).toHaveBeenCalledTimes(1);
  });

  it("gates unparented human turns on registered watchers", async () => {
    const database = createDatabaseOptions();
    const entry = { sessionId: "session-child", updatedAt: Date.now() };
    await recordSessionHumanDirectMessage({
      sessionKey: child,
      entry,
      agentId: "main",
      actor: { actorType: "human" },
      channel: "webchat",
    });
    expect(listSessionStateEventsSince(child, "main", 0, 200, database).events).toHaveLength(0);

    registerSessionStateWatch({ watcherSessionKey: watcher, targetSessionKey: child }, database);
    await recordSessionHumanDirectMessage({
      sessionKey: child,
      entry,
      agentId: "main",
      actor: { actorType: "human" },
      channel: "webchat",
    });

    const events = listSessionStateEventsSince(child, "main", 0, 200, database).events;
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "human_direct_message" });
    expect(peekSystemEventEntries(watcher)).toHaveLength(1);
  });

  it("projects spawn, terminal, goal, and compaction producer helpers", async () => {
    const database = createDatabaseOptions();
    recordSessionCreated(cfg, {
      sessionKey: child,
      agentId: "main",
      entry: {
        sessionId: "session-child",
        updatedAt: Date.now(),
        createdVia: "spawn",
        createdActor: { type: "agent", id: watcher },
        createdAt: Date.now(),
      },
    });
    recordSubagentSpawned({
      childSessionKey: child,
      childRunId: "run-child",
      requesterSessionKey: watcher,
      agentId: "main",
    });
    const terminalContext = captureOpenClawStateWorkerContext(database);
    const assertTerminalCurrent = () => terminalContext.admission.assertCurrent();
    await recordSubagentTerminalState(
      {
        childSessionKey: child,
        runId: "run-child",
        requesterSessionKey: watcher,
        outcomeStatus: "ok",
      },
      assertTerminalCurrent,
    );
    await recordSubagentTerminalState(
      {
        childSessionKey: child,
        runId: "run-child",
        requesterSessionKey: watcher,
        outcomeStatus: "ok",
      },
      assertTerminalCurrent,
    );
    await recordSubagentTerminalState(
      {
        childSessionKey: child,
        runId: "run-child-cancelled",
        requesterSessionKey: watcher,
        outcomeStatus: "cancelled",
      },
      assertTerminalCurrent,
    );
    await recordSessionGoalChanged({
      sessionKey: child,
      entry: {
        sessionId: "session-child",
        updatedAt: Date.now(),
        spawnedBy: watcher,
      },
      actor: { type: "human" },
      summary: "goal created",
    });
    recordSessionCompacted({
      sessionKey: child,
      operationId: "compact-1",
      sessionId: "session-child",
    });
    recordSessionCompacted({
      sessionKey: child,
      operationId: "compact-1",
      sessionId: "session-child",
    });

    const events = listSessionStateEventsSince(child, "main", 0, 200, database).events;
    expect(events.map((event) => event.kind)).toEqual([
      "created",
      "child_spawned",
      "run_completed",
      "run_failed",
      "goal_changed",
      "compacted",
    ]);
    expect(events[0]).toMatchObject({
      actorType: "agent",
      actorId: watcher,
      summary: "session created",
    });
    expect(events[3]).toMatchObject({
      runId: "run-child-cancelled",
      summary: "child run cancelled",
      payload: { outcome: "cancelled" },
    });
  });
});
