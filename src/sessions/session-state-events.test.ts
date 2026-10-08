import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { trackSqliteStatementExecutions } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { drainFormattedSystemEvents } from "../auto-reply/reply/session-system-events.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import { captureSessionEntryCurrentRead } from "../config/sessions/session-entry-current-runtime.js";
import { withSessionEntryReadOnlyInWorker } from "../config/sessions/session-entry-read-runtime.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { requestHeartbeat, setHeartbeatWakeHandler } from "../infra/heartbeat-wake.js";
import {
  enqueueSystemEvent,
  peekSystemEventEntries,
  resetSystemEventsForTest,
} from "../infra/system-events.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { recordSessionCreated } from "./session-created.js";
import {
  classifySessionStateActor,
  getSessionStateVersion,
  handleSessionStateSessionDeleted,
  listAmbientGroupWatchTargets,
  listSessionStateEventsSince,
  recordSessionCompacted,
  recordSessionGoalChanged,
  recordSessionHumanDirectMessage,
  recordSessionStateEventAsync,
  recordSubagentSpawned,
  registerMainSessionGroupWatch,
  registerSessionStateWatch,
  sweepSessionStateWatchNotices,
} from "./session-state-events.js";
import {
  recordSessionStateEventInDatabase,
  type SessionStateEventRow,
} from "./session-state-events.kernel.js";
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
import { prepareSubagentTerminalState } from "./subagent-terminal-state.js";

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
    await seedChild(database, nestedWatcher);

    await recordSessionStateEventAsync(
      eventInput({ watcherSessionKeys: [nestedWatcher] }),
      database,
    );
    await vi.advanceTimersByTimeAsync(21_000);
    expect(peekSystemEventEntries(nestedWatcher)).toHaveLength(1);
    expect(wakes).not.toHaveBeenCalled();

    await seedChild(database, watcher);
    await recordSessionStateEventAsync(eventInput(), database);
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

  it("suppresses cursors and notices for agent-ambiguous bare watcher keys", async () => {
    const database = createDatabaseOptions();
    const event = (await recordSessionStateEventAsync(
      eventInput({ watcherSessionKeys: ["global"] }),
      database,
    ))!;
    expect(event.sequence).toBeGreaterThan(0);
    expect(peekSystemEventEntries("agent:main:global")).toEqual([]);
    const cursorRow = openOpenClawStateDatabase(database)
      .db.prepare("SELECT COUNT(*) AS n FROM session_watch_cursors")
      .get() as { n: number };
    expect(cursorRow.n).toBe(0);
  });

  it("keeps same-keyed global sessions independent across agents", async () => {
    const database = createDatabaseOptions();
    const mainEvent = (await recordSessionStateEventAsync(
      eventInput({
        sessionKey: "global",
        agentId: "main",
        kind: "goal_changed",
        actorType: "human",
        watcherSessionKeys: [],
      }),
      database,
    ))!;
    const opsEvent = (await recordSessionStateEventAsync(
      eventInput({
        sessionKey: "global",
        agentId: "ops",
        kind: "goal_changed",
        actorType: "human",
        watcherSessionKeys: [],
      }),
      database,
    ))!;

    expect(await getSessionStateVersion("global", "main", database)).toBe(mainEvent.sequence);
    expect(await getSessionStateVersion("global", "ops", database)).toBe(opsEvent.sequence);
    expect(
      (await listSessionStateEventsSince("global", "main", 0, 200, database)).events.map(
        (event) => event.sequence,
      ),
    ).toEqual([mainEvent.sequence]);

    await handleSessionStateSessionDeleted("global", "ops", database);
    expect(await getSessionStateVersion("global", "ops", database)).toBe(0);
    expect(await getSessionStateVersion("global", "main", database)).toBe(mainEvent.sequence);
  });

  it("acks only drained session-state entries and ignores ordinary events", async () => {
    const database = createDatabaseOptions();
    await seedChild(database);
    const material = (await recordSessionStateEventAsync(eventInput(), database))!;
    enqueueSystemEvent("Cron completed", { sessionKey: watcher, contextKey: "cron:job-1" });

    await drainFormattedSystemEvents({
      cfg,
      agentId: "main",
      sessionKey: watcher,
      isMainSession: false,
      isNewSession: false,
    });
    expect(readCursor(database)?.last_seen_sequence).toBe(material.sequence);

    await recordSessionStateEventAsync(eventInput(), database);
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

describe("session state watcher cursor batches", () => {
  it("advances watcher fanout with bounded cursor reads and preserves excluded cursors", async () => {
    const database = createDatabaseOptions();
    await seedChild(database, nestedWatcher);
    const { db } = openOpenClawStateDatabase(database);
    const watchers = Array.from(
      { length: 1_001 },
      (_, index) => `agent:main:subagent:fanout-${index}`,
    );
    const actor = "agent:main:subagent:actor";
    const stale = "agent:main:subagent:stale";
    const missing = "agent:main:subagent:missing";
    const insert = db.prepare(`INSERT INTO session_watch_cursors
      (watcher_session_key, target_session_key, last_seen_sequence, notified_sequence,
       material_sequence, updated_at) VALUES (?, ?, ?, 1, 1, ?)`);
    for (const [index, key] of watchers.entries()) {
      insert.run(key, child, index % 2, Date.now());
    }
    insert.run(actor, child, 1, 9_007_199_254_740_992n);
    insert.run("global", child, 1, 9_007_199_254_740_992n);
    insert.run(stale, child, 1, Date.now());
    insert.run(missing, "other-target", 1, Date.now());
    const staleBefore = readCursor(database, stale);
    const reads = trackSqliteStatementExecutions(db, ["cursors"], (sql) =>
      /^select\b/i.test(sql) && /\bfrom\s+"session_watch_cursors"/i.test(sql) ? "cursors" : null,
    );
    let event: SessionStateEventRow | undefined;
    try {
      event = runOpenClawStateWriteTransaction(
        ({ db: transactionDb }) =>
          recordSessionStateEventInDatabase(
            transactionDb,
            eventInput({
              actorId: actor,
              watcherSessionKeys: [watchers[0]!, missing, watchers[0]!, actor, "global", stale],
              watcherStorePaths: { [stale]: "/synthetic/retired-store.sqlite" },
            }),
            Date.now(),
          ).row,
        database,
      );
    } finally {
      reads.restore();
    }
    expect(event?.sequence).toBeGreaterThan(1);
    for (const [index, key] of watchers.entries()) {
      expect(readCursor(database, key)).toEqual({
        last_seen_sequence: index % 2,
        notified_sequence: index % 2 === 0 ? 1 : event?.sequence,
        material_sequence: event?.sequence,
      });
    }
    expect(readCursor(database, missing)).toEqual({
      last_seen_sequence: 0,
      notified_sequence: event?.sequence,
      material_sequence: event?.sequence,
    });
    for (const key of [actor, "global", stale]) {
      expect(readCursor(database, key)).toEqual(staleBefore);
    }
    expect(readCursor(database, missing, "other-target")).toEqual(staleBefore);
    expect(reads.counts.cursors).toBeLessThanOrEqual(4);
  });

  it("preserves sequential store custody when watcher strings share a SQLite binding", () => {
    const database = createDatabaseOptions();
    const first = "agent:main:subagent:\ud800";
    const second = "agent:main:subagent:\ud801";
    const result = runOpenClawStateWriteTransaction(
      ({ db }) =>
        recordSessionStateEventInDatabase(
          db,
          eventInput({
            watcherSessionKeys: [first, second],
            watcherStorePaths: {
              [first]: "/synthetic/first.sqlite",
              [second]: "/synthetic/second.sqlite",
            },
          }),
          Date.now(),
        ),
      database,
    );
    expect(result.row?.sequence).toBeGreaterThan(0);
    expect(result.notices.map((notice) => notice.watcherStorePath)).toEqual([
      "/synthetic/first.sqlite",
      null,
    ]);
    expect(
      openOpenClawStateDatabase(database)
        .db.prepare(
          "SELECT watcher_store_path FROM session_watch_cursors WHERE target_session_key = ?",
        )
        .all(child),
    ).toEqual([{ watcher_store_path: "/synthetic/first.sqlite" }]);
  });
});
