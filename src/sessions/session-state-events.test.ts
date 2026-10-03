import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { drainFormattedSystemEvents } from "../auto-reply/reply/session-system-events.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import { captureSessionEntryCurrentRead } from "../config/sessions/session-entry-current-runtime.js";
import { withSessionEntryReadOnlyInWorker } from "../config/sessions/session-entry-read-runtime.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getLastHeartbeatEvent, resetHeartbeatEventsForTest } from "../infra/heartbeat-events.js";
import { assertSqliteSchemaContains } from "../infra/sqlite-schema-contract.js";
import { publishSystemEventStoreResolver } from "../infra/system-event-ownership.js";
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
  recordSessionStateEventAsync,
  recordSubagentSpawned,
  registerMainSessionGroupWatch,
  registerSessionStateWatch,
  sweepSessionStateWatchNotices,
} from "./session-state-events.js";
import { registerSessionStateNoticeHandoffCases } from "./session-state-events.notice-handoff.cases.js";
import {
  child,
  cleanupSessionStateTestState,
  createDatabaseOptions,
  createWatcherSession,
  eventInput,
  readCursor,
  seedChild,
  watcher,
} from "./session-state-events.test-support.js";
import { prepareSubagentTerminalState } from "./subagent-terminal-state.js";

const noticeHandoff = vi.hoisted(() => ({
  capture:
    vi.fn<
      typeof import("../auto-reply/reply/session-event-handoff.js").captureSessionEventTargetForHost
    >(),
  enqueue:
    vi.fn<
      typeof import("../auto-reply/reply/session-event-handoff.js").enqueueSessionEventForHost
    >(),
}));
vi.mock("../auto-reply/reply/session-event-handoff.js", () => ({
  assertSessionEventTargetCurrent: (target: { assertCurrent?: () => void }) =>
    target.assertCurrent?.(),
  captureSessionEventTargetForHost: noticeHandoff.capture,
  enqueueSessionEventForHost: noticeHandoff.enqueue,
}));

const SESSION_STATE_MAX_ROWS = 50_000;
const SESSION_STATE_RETENTION_MS = 30 * 24 * 60 * 60_000;
const group = "agent:main:telegram:group:room-1";
const cfg = {} as OpenClawConfig;

beforeEach(() => {
  noticeHandoff.capture.mockReset().mockImplementation(async (agentId, sessionKey, options) => ({
    agentId,
    sessionKey,
    sessionId: `session-${sessionKey}`,
    generation: "notice-test-generation",
    assertCurrent: options?.assertCurrent,
  }));
  noticeHandoff.enqueue.mockReset().mockImplementation((_text, options) => ({
    id: options.occurrence?.id ?? "unexpected-new-occurrence",
    cancel: () => false,
    settled: Promise.resolve({ status: "completed", executionStarted: false, delivered: false }),
  }));
});

afterEach(async () => {
  publishSystemEventStoreResolver(undefined);
  await cleanupSessionStateTestState();
});

describe("session state events", () => {
  it.each(
    [
      { change: "ownership", key: child, field: "lifecycleRunId", records: false },
      { change: "metadata", key: child, field: "completionOwnerSessionKey", records: true },
      { change: "another session", key: watcher, field: "lifecycleRunId", records: true },
    ].flatMap(({ change, key, field, records }) =>
      [1, 2].map((verdict) => ({ change, key, field, records, verdict })),
    ),
  )(
    "records=$records after $change changes during native verdict $verdict",
    async ({ key, field, records, verdict }) => {
      const database = createDatabaseOptions();
      const target = { agentId: "main", sessionKey: child, env: database.env };
      const entry = { sessionId: "session-child", updatedAt: 1, lifecycleRunId: "original-run" };
      await upsertSessionEntryCore(target, entry);
      await createWatcherSession(database);
      openOpenClawStateDatabase(database);
      const current = await withSessionEntryReadOnlyInWorker(
        target,
        () => {},
        async (read, owner) => {
          if (!read.ok) {
            throw read.error;
          }
          return captureSessionEntryCurrentRead(target, owner);
        },
      );
      if (!current.source) {
        throw new Error("Expected a file-backed source");
      }
      let changedAfterVerdict = false;
      let verdicts = 0;
      const peer = new DatabaseSync(current.source.path);
      const check = {
        source: current.source,
        assertCurrent: (facts: { lifecycleRunId?: unknown } | undefined) => {
          current.assertSourceCurrent();
          expect(facts?.lifecycleRunId).toBe("original-run");
          if (++verdicts === verdict) {
            peer
              .prepare(
                "UPDATE session_nodes SET entry_json = json_set(entry_json, ?, ?) WHERE session_key = ?",
              )
              .run(`$.${field}`, "successor-run", key);
            changedAfterVerdict = true;
          }
        },
      };
      try {
        const input = eventInput({ watcherSessionKeys: [], dedupeKey: "currency-signal" });
        const options = { ...database, now: 0, sessionEntryCurrent: check };
        const recorded = await recordSessionStateEventAsync(input, options);
        expect(changedAfterVerdict).toBe(true);
        if (records) {
          expect(recorded).toMatchObject({ sessionKey: child, sessionId: entry.sessionId });
          expect(await getSessionStateVersion(child, "main", database)).toBeGreaterThan(0);
        } else {
          expect(recorded).toBeUndefined();
          expect(await getSessionStateVersion(child, "main", database)).toBe(0);
        }

        await upsertSessionEntryCore(target, entry);
        expect(await recordSessionStateEventAsync(input, options)).toMatchObject({
          sessionKey: child,
          sessionId: entry.sessionId,
        });
        expect(await getSessionStateVersion(child, "main", database)).toBeGreaterThan(0);
      } finally {
        peer.close();
      }
    },
  );

  it("does not advance a replacement watch from older producer facts", async () => {
    const database = createDatabaseOptions();
    resetHeartbeatEventsForTest();
    await registerSessionStateWatch(
      { watcherSessionKey: watcher, targetSessionKey: child },
      database,
    );
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
  it("preserves older readers and version markers when watcher provenance is first written", async () => {
    const database = createDatabaseOptions();
    const before = openOpenClawStateDatabase(database);
    before.db.exec("ALTER TABLE session_watch_cursors DROP COLUMN watcher_store_path");
    const userVersion = before.db.prepare("PRAGMA user_version").get();
    closeOpenClawStateDatabaseForTest();
    const reopened = openOpenClawStateDatabase(database);
    const schemaBeforeRead = reopened.db.prepare("PRAGMA schema_version").get();
    expect(await getSessionStateVersion(child, "main", database)).toBe(0);
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

  it("bumps a durable head that survives pruning all retained rows", async () => {
    const database = createDatabaseOptions();
    const now = Date.now();
    const event = recordSessionStateEvent(eventInput(), { ...database, now });
    expect(await getSessionStateVersion(child, "main", database)).toBe(event?.sequence);

    await sweepSessionStateWatchNotices({
      ...database,
      now: now + SESSION_STATE_RETENTION_MS + 1,
    });

    expect((await listSessionStateEventsSince(child, "main", 0, 200, database)).events).toEqual([]);
    expect(await getSessionStateVersion(child, "main", database)).toBe(event?.sequence);
  });

  registerSessionStateNoticeHandoffCases(noticeHandoff, cfg);

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

  it("records log-only kinds without queueing notices", async () => {
    const database = createDatabaseOptions();
    const event = recordSessionStateEvent(
      eventInput({ kind: "compacted", actorType: "system" }),
      database,
    );

    expect(await getSessionStateVersion(child, "main", database)).toBe(event?.sequence);
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

  it("returns the existing row for a duplicate dedupe key", async () => {
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
    expect(
      (await listSessionStateEventsSince(child, "main", 0, 200, database)).events,
    ).toHaveLength(1);
  });

  it("re-enqueues and re-freezes pending notices after restart", async () => {
    const database = createDatabaseOptions();
    await createWatcherSession(database);
    seedChild(database);
    const material = recordSessionStateEvent(eventInput(), database)!;
    resetSystemEventsForTest();

    await sweepSessionStateWatchNotices(database);

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

  it("prunes retention and cap rows while keeping monotonic autoincrement heads", async () => {
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

    await sweepSessionStateWatchNotices({ ...database, now });
    const count = db.prepare("SELECT count(*) AS count FROM session_state_events").get() as {
      count: number;
    };
    expect(count.count).toBe(SESSION_STATE_MAX_ROWS);

    const next = recordSessionStateEvent(eventInput(), { ...database, now: now + 1 })!;
    expect(next.sequence).toBeGreaterThan(before.sequence);
    expect(await getSessionStateVersion(child, "main", database)).toBe(next.sequence);
  });

  it("prunes many composite session heads without recreating or regressing them", async () => {
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

    await sweepSessionStateWatchNotices({ ...database, now });

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
  });

  it("lists typed ascending deltas with truncation and history-gap signaling", async () => {
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

    const page = await listSessionStateEventsSince(child, "main", 0, 2, database);
    expect(page.events.map((event) => event.summary)).toEqual(["first", "second"]);
    expect(page.events[1]?.payload).toEqual({ status: "active" });
    expect(page.truncated).toBe(true);

    // A manually removed row is not a retention gap: only pruning stamps the
    // per-session watermark that historyGap may consult.
    openOpenClawStateDatabase(database)
      .db.prepare("DELETE FROM session_state_events WHERE sequence = ?")
      .run(first.sequence);
    expect((await listSessionStateEventsSince(child, "main", 0, 200, database)).historyGap).toBe(
      false,
    );
  });

  it("reports history gaps only for actually pruned events, not sparse global sequences", async () => {
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
    expect((await listSessionStateEventsSince(child, "main", 0, 200, database)).historyGap).toBe(
      false,
    );

    const later = now + SESSION_STATE_RETENTION_MS + 1;
    const fresh = recordSessionStateEvent(eventInput({ summary: "fresh" }), {
      ...database,
      now: later,
    })!;
    await sweepSessionStateWatchNotices({ ...database, now: later });

    const sincePruned = await listSessionStateEventsSince(child, "main", 0, 200, database);
    expect(sincePruned.historyGap).toBe(true);
    expect(sincePruned.events.map((event) => event.summary)).toEqual(["fresh"]);
    expect(
      (await listSessionStateEventsSince(child, "main", old.sequence, 200, database)).historyGap,
    ).toBe(false);
    expect(await getSessionStateVersion(child, "main", database)).toBe(fresh.sequence);
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

  it("keeps same-keyed global sessions independent across agents", async () => {
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

    expect(await getSessionStateVersion("global", "main", database)).toBe(mainEvent.sequence);
    expect(await getSessionStateVersion("global", "ops", database)).toBe(opsEvent.sequence);
    expect(
      (await listSessionStateEventsSince("global", "main", 0, 200, database)).events.map(
        (event) => event.sequence,
      ),
    ).toEqual([mainEvent.sequence]);

    handleSessionStateSessionDeleted("global", "ops", database);
    expect(await getSessionStateVersion("global", "ops", database)).toBe(0);
    expect(await getSessionStateVersion("global", "main", database)).toBe(mainEvent.sequence);
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

  it("keeps target history on reset and removes all ownership on delete", async () => {
    const database = createDatabaseOptions();
    seedChild(database);
    recordSessionStateEvent(eventInput(), database);

    handleSessionStateSessionReset(watcher, database);
    expect(readCursor(database)).toBeUndefined();
    expect(
      (await listSessionStateEventsSince(child, "main", 0, 200, database)).events.length,
    ).toBeGreaterThan(0);

    handleSessionStateSessionDeleted(child, "main", database);
    expect(await getSessionStateVersion(child, "main", database)).toBe(0);
    expect((await listSessionStateEventsSince(child, "main", 0, 200, database)).events).toEqual([]);
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

  it("registers explicit watchers who get notices only for later changes", async () => {
    const database = createDatabaseOptions();
    const preRegistration = recordSessionStateEvent(
      eventInput({ watcherSessionKeys: [] }),
      database,
    )!;

    expect(
      await registerSessionStateWatch({ watcherSessionKey: child, targetSessionKey: child }),
    ).toBe(false);
    expect(
      await registerSessionStateWatch({ watcherSessionKey: "global", targetSessionKey: child }),
    ).toBe(false);
    expect(
      await registerSessionStateWatch(
        { watcherSessionKey: watcher, targetSessionKey: child },
        database,
      ),
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
      await registerSessionStateWatch(
        { watcherSessionKey: watcher, targetSessionKey: child },
        database,
      ),
    ).toBe(true);
    expect(readCursor(database)).toEqual({
      last_seen_sequence: preRegistration.sequence,
      notified_sequence: afterRegistration.sequence,
      material_sequence: afterRegistration.sequence,
    });
  });

  it.each(["ambient", "explicit"])(
    "rebinds a replaced %s watch on the next group turn",
    async (kind) => {
      const database = createDatabaseOptions();
      if (kind === "explicit") {
        await registerSessionStateWatch(
          { watcherSessionKey: watcher, targetSessionKey: group },
          database,
        );
      } else {
        await registerMainSessionGroupWatch({ sessionKey: group, agentId: "main" }, database);
      }
      const { db } = openOpenClawStateDatabase(database);
      db.prepare("UPDATE session_watch_cursors SET watcher_store_path = ?").run(
        "/retired/store.sqlite",
      );
      expect(
        await registerMainSessionGroupWatch({ sessionKey: group, agentId: "main" }, database),
      ).toBe(true);
      expect(
        db.prepare("SELECT watcher_store_path, provenance FROM session_watch_cursors").get(),
      ).toEqual({
        watcher_store_path: expect.not.stringContaining("/retired/"),
        provenance: "ambient-group",
      });
      recordSessionStateEvent(eventInput({ sessionKey: group, watcherSessionKeys: [] }), database);
      expect(peekSystemEventEntries(watcher)).toHaveLength(1);
    },
  );

  it("registers one ambient main watcher for a distinct group session", async () => {
    const database = createDatabaseOptions();
    expect(
      await registerMainSessionGroupWatch(
        { sessionKey: group, agentId: "main" },
        { ...database, now: 100 },
      ),
    ).toBe(true);
    expect(
      await registerMainSessionGroupWatch(
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

  it("does not register a group routed into the configured main session", async () => {
    const database = createDatabaseOptions();
    const mainSessionKey = "agent:main:work";

    expect(
      await registerMainSessionGroupWatch(
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

  it("records and coalesces ambient group activity without admitting an extra turn", async () => {
    vi.useFakeTimers();
    const database = createDatabaseOptions();
    await registerMainSessionGroupWatch({ sessionKey: group, agentId: "main" }, database);

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

    expect(
      (await listSessionStateEventsSince(group, "main", 0, 200, database)).events,
    ).toHaveLength(2);
    expect(peekSystemEventEntries(watcher)).toHaveLength(1);
    const cursor = readCursor(database, watcher, group);
    expect(cursor).toBeDefined();
    expect(cursor!.material_sequence).toBeGreaterThan(cursor!.notified_sequence);
    expect(noticeHandoff.capture).not.toHaveBeenCalled();
    expect(noticeHandoff.enqueue).not.toHaveBeenCalled();
  });

  it("prunes dormant ambient cursors while retaining active cursors", async () => {
    const database = createDatabaseOptions();
    const dormantGroup = "agent:main:slack:channel:dormant";
    const registeredAt = 100;
    await registerMainSessionGroupWatch(
      { sessionKey: group, agentId: "main" },
      { ...database, now: registeredAt },
    );
    await registerMainSessionGroupWatch(
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
    await sweepSessionStateWatchNotices({ ...database, now: activeAt });

    expect(listAmbientGroupWatchTargets(watcher, database)).toEqual(new Set([group]));
    const cursors = openOpenClawStateDatabase(database)
      .db.prepare("SELECT COUNT(*) AS count FROM session_watch_cursors")
      .get() as { count: number };
    expect(cursors.count).toBe(1);
  });

  it("admits explicit A2A group watches through ordinary session events", async () => {
    vi.useFakeTimers();
    const database = createDatabaseOptions();
    const coordinator = "agent:main:coordinator";
    await registerSessionStateWatch(
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
    expect(noticeHandoff.enqueue).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining(`Session "${group}" changed`),
      expect.objectContaining({
        sessionKey: coordinator,
        occurrence: peekSystemEventEntries(coordinator)[0],
      }),
    );
  });

  it("promotes an ambient main-to-group watch to explicit immediate delivery", async () => {
    vi.useFakeTimers();
    const database = createDatabaseOptions();
    await registerMainSessionGroupWatch({ sessionKey: group, agentId: "main" }, database);
    expect(listAmbientGroupWatchTargets(watcher, database)).toEqual(new Set([group]));

    await registerSessionStateWatch(
      { watcherSessionKey: watcher, targetSessionKey: group },
      database,
    );
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
    await registerMainSessionGroupWatch({ sessionKey: group, agentId: "main" }, database);

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
    expect(noticeHandoff.enqueue).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining(`Session "${group}" changed`),
      expect.objectContaining({
        sessionKey: watcher,
        occurrence: peekSystemEventEntries(watcher)[0],
      }),
    );
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
    expect(
      (await listSessionStateEventsSince(child, "main", 0, 200, database)).events,
    ).toHaveLength(0);

    await registerSessionStateWatch(
      { watcherSessionKey: watcher, targetSessionKey: child },
      database,
    );
    await recordSessionHumanDirectMessage({
      sessionKey: child,
      entry,
      agentId: "main",
      actor: { actorType: "human" },
      channel: "webchat",
    });

    const events = (await listSessionStateEventsSince(child, "main", 0, 200, database)).events;
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "human_direct_message" });
    expect(peekSystemEventEntries(watcher)).toHaveLength(1);
  });

  it("projects spawn, terminal, goal, and compaction producer helpers", async () => {
    const database = createDatabaseOptions();
    await recordSessionCreated(cfg, {
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
    await recordSubagentSpawned({
      childSessionKey: child,
      childRunId: "run-child",
      requesterSessionKey: watcher,
      agentId: "main",
    });
    const terminalContext = captureOpenClawStateWorkerContext(database);
    const assertTerminalCurrent = () => terminalContext.admission.assertCurrent();
    for (const terminal of [
      { runId: "run-child", outcomeStatus: "ok" },
      { runId: "run-child", outcomeStatus: "ok" },
      { runId: "run-child-cancelled", outcomeStatus: "cancelled" },
    ] as const) {
      const prepared = prepareSubagentTerminalState({
        childSessionKey: child,
        requesterSessionKey: watcher,
        ...terminal,
      });
      await recordSessionStateEventAsync(prepared.input.event, {
        assertCurrent: assertTerminalCurrent,
      });
    }
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
    await recordSessionCompacted({
      sessionKey: child,
      operationId: "compact-1",
      sessionId: "session-child",
    });
    await recordSessionCompacted({
      sessionKey: child,
      operationId: "compact-1",
      sessionId: "session-child",
    });

    const events = (await listSessionStateEventsSince(child, "main", 0, 200, database)).events;
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
