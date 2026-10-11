import { afterEach, describe, expect, it } from "vitest";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import { peekSystemEventEntries, resetSystemEventsForTest } from "../infra/system-events.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { prepareAmbientGroupWatchTargetsRead } from "./session-state-events.ambient-read.js";
import {
  acknowledgeSessionStateNotices,
  handleSessionStateSessionDeleted,
  handleSessionStateSessionReset,
  listAmbientGroupWatchTargets,
  listSessionStateEventsSince,
  recordSessionStateEventAsync,
  registerSessionStateWatch,
  sweepSessionStateWatchNotices,
} from "./session-state-events.js";
import {
  child,
  cleanupSessionStateTestState,
  createDatabaseOptions,
  eventInput,
  readCursor,
  watcher,
} from "./session-state-events.test-support.js";
import { enqueueSessionStateNotice } from "./session-state-notices.js";

afterEach(cleanupSessionStateTestState);

describe("session state watch ownership", () => {
  it("refuses raw, malformed, and contradictory watch addresses before registering", async () => {
    const database = createDatabaseOptions();
    for (const address of [
      { watcherSessionKey: watcher, targetSessionKey: "global", targetAgentId: "main" },
      { watcherSessionKey: watcher, targetSessionKey: "global", targetAgentId: "worker" },
      { watcherSessionKey: "global", targetSessionKey: child },
      { watcherSessionKey: "agent:bad/id:main", targetSessionKey: child },
      { watcherSessionKey: watcher, targetSessionKey: "agent:bad/id:main" },
      { watcherSessionKey: watcher, targetSessionKey: child, targetAgentId: "worker" },
      { watcherSessionKey: watcher, targetSessionKey: child, targetAgentId: "" },
    ]) {
      expect(await registerSessionStateWatch(address, database), JSON.stringify(address)).toBe(
        false,
      );
      expect(
        readCursor(database, address.watcherSessionKey, address.targetSessionKey),
      ).toBeUndefined();
    }
    expect(
      await registerSessionStateWatch(
        { watcherSessionKey: watcher, targetSessionKey: child, targetAgentId: "main" },
        database,
      ),
    ).toBe(true);
  });

  it("keeps raw event history agent-scoped without seeding or publishing ambiguous watches", async () => {
    const database = createDatabaseOptions();
    for (const agentId of ["main", "worker"]) {
      for (const kind of ["child_spawned", "human_direct_message"] as const) {
        await recordSessionStateEventAsync(
          eventInput({ sessionKey: "global", agentId, kind }),
          database,
        );
      }
    }
    await recordSessionStateEventAsync(eventInput({ agentId: "worker" }), database);
    expect(readCursor(database, watcher, "global")).toBeUndefined();
    expect(readCursor(database)).toBeUndefined();
    expect(peekSystemEventEntries(watcher)).toEqual([]);
    for (const agentId of ["main", "worker"]) {
      const events = (await listSessionStateEventsSince("global", agentId, 0, 200, database))
        .events;
      expect(events).toHaveLength(2);
      expect(events.every((event) => event.agentId === agentId)).toBe(true);
    }
  });

  it("retains historical unbound cursors inert through restart, acknowledgment, and deletion until expiry", async () => {
    const database = createDatabaseOptions();
    const now = Date.now();
    await upsertSessionEntryCore(
      { sessionKey: watcher, env: database.env },
      { sessionId: "watcher-session", updatedAt: now },
    );
    await registerSessionStateWatch(
      { watcherSessionKey: watcher, targetSessionKey: child },
      database,
    );
    const { db } = openOpenClawStateDatabase(database);
    const { watcher_store_path: watcherStorePath } = db
      .prepare("SELECT watcher_store_path FROM session_watch_cursors")
      .get() as { watcher_store_path: string };
    const insert = db.prepare(`INSERT INTO session_watch_cursors
      (watcher_session_key, target_session_key, watcher_store_path, last_seen_sequence,
       notified_sequence, material_sequence, provenance, updated_at)
      SELECT ?, ?, watcher_store_path, 1, 3, 9, 'ambient-group', ?
      FROM session_watch_cursors WHERE watcher_session_key = ? AND target_session_key = ?`);
    const addresses = [
      { watcherSessionKey: watcher, targetSessionKey: "global" },
      { watcherSessionKey: "global", targetSessionKey: child },
      { watcherSessionKey: watcher, targetSessionKey: "agent:bad/id:main" },
    ];
    for (const address of addresses) {
      insert.run(address.watcherSessionKey, address.targetSessionKey, now, watcher, child);
    }
    const readRetained = () =>
      openOpenClawStateDatabase(database)
        .db.prepare(
          "SELECT * FROM session_watch_cursors WHERE provenance = 'ambient-group' ORDER BY watcher_session_key, target_session_key",
        )
        .all();
    const retained = readRetained();

    for (const agentId of ["main", "worker"]) {
      await recordSessionStateEventAsync(eventInput({ sessionKey: "global", agentId }), database);
    }
    expect(readRetained()).toEqual(retained);
    expect(listAmbientGroupWatchTargets(watcher, database)).toEqual(new Set());
    const ambient = prepareAmbientGroupWatchTargetsRead(watcher, database);
    try {
      expect(await ambient.read()).toEqual([]);
    } finally {
      ambient.release();
    }
    for (const address of addresses) {
      enqueueSessionStateNotice({ ...address, watcherStorePath, lastSeenSequence: 1 });
      await acknowledgeSessionStateNotices(
        address.watcherSessionKey,
        [{ targetSessionKey: address.targetSessionKey, watcherStorePath }],
        database,
      );
    }
    expect(peekSystemEventEntries(watcher)).toEqual([]);
    expect(() => peekSystemEventEntries("global")).toThrow("agent-qualified");
    expect(readRetained()).toEqual(retained);

    resetSystemEventsForTest();
    await closeOpenClawStateDatabaseAsync();
    await sweepSessionStateWatchNotices({ ...database, now });
    expect(peekSystemEventEntries(watcher)).toEqual([]);
    expect(readRetained()).toEqual(retained);
    for (const sessionKey of ["global", watcher, child]) {
      await handleSessionStateSessionReset(sessionKey, database);
      await handleSessionStateSessionDeleted(sessionKey, "main", database);
      expect(readRetained()).toEqual(retained);
    }
    await sweepSessionStateWatchNotices({
      ...database,
      now: now + 30 * 24 * 60 * 60_000 + 1,
    });
    expect(readRetained()).toEqual([]);
  });
});
