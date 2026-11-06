import { afterEach, beforeEach, expect, it } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import { peekSystemEventEntries, resetSystemEventsForTest } from "../infra/system-events.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { prepareAmbientGroupWatchTargetsRead } from "./session-state-events.ambient-read.js";
import * as events from "./session-state-events.js";
import * as fixture from "./session-state-events.test-support.js";
import { enqueueSessionStateNotice } from "./session-state-notices.js";

const { child, watcher } = fixture;
let database: ReturnType<typeof fixture.createDatabaseOptions>;
beforeEach(() => {
  database = fixture.createDatabaseOptions();
  setRuntimeConfigSnapshot({});
});
afterEach(async () => {
  await fixture.cleanupSessionStateTestState();
  clearRuntimeConfigSnapshot();
});

const register = (targetAgentId?: string) =>
  events.registerSessionStateWatch(
    { watcherSessionKey: watcher, targetSessionKey: child, targetAgentId },
    database,
  );
const record = (input: Parameters<typeof fixture.eventInput>[0]) =>
  events.recordSessionStateEventAsync(fixture.eventInput(input), database);

it("refuses raw, malformed, and contradictory watch addresses before registering", async () => {
  for (const address of [
    { watcherSessionKey: watcher, targetSessionKey: "global", targetAgentId: "main" },
    { watcherSessionKey: watcher, targetSessionKey: "global", targetAgentId: "worker" },
    { watcherSessionKey: "global", targetSessionKey: child },
    { watcherSessionKey: "agent:bad/id:main", targetSessionKey: child },
    { watcherSessionKey: watcher, targetSessionKey: "agent:bad/id:main" },
    { watcherSessionKey: watcher, targetSessionKey: child, targetAgentId: "worker" },
    { watcherSessionKey: watcher, targetSessionKey: child, targetAgentId: "" },
  ]) {
    expect(await events.registerSessionStateWatch(address, database), JSON.stringify(address)).toBe(
      false,
    );
    expect(
      fixture.readCursor(database, address.watcherSessionKey, address.targetSessionKey),
    ).toBeUndefined();
  }
  expect(await register("main")).toBe(true);
});

it("keeps raw event history agent-scoped without seeding or publishing ambiguous watches", async () => {
  for (const agentId of ["main", "worker"]) {
    for (const kind of ["child_spawned", "human_direct_message"] as const) {
      await record({ sessionKey: "global", agentId, kind });
    }
  }
  await record({ agentId: "worker" });
  expect(fixture.readCursor(database, watcher, "global")).toBeUndefined();
  expect(fixture.readCursor(database)).toBeUndefined();
  expect(peekSystemEventEntries(watcher)).toEqual([]);
  for (const agentId of ["main", "worker"]) {
    const history = (await events.listSessionStateEventsSince("global", agentId, 0, 200, database))
      .events;
    expect(history).toHaveLength(2);
    expect(history.every((event) => event.agentId === agentId)).toBe(true);
  }
});

it("retains historical unbound cursors inert through restart, acknowledgment, and deletion until expiry", async () => {
  const now = Date.now();
  await upsertSessionEntryCore(
    { sessionKey: watcher, env: database.env },
    { sessionId: "watcher-session", updatedAt: now },
  );
  await register();
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
    await record({ sessionKey: "global", agentId });
  }
  expect(readRetained()).toEqual(retained);
  expect(events.listAmbientGroupWatchTargets(watcher, database)).toEqual(new Set());
  const ambient = prepareAmbientGroupWatchTargetsRead(watcher, database);
  try {
    expect(await ambient.read()).toEqual([]);
  } finally {
    ambient.release();
  }
  for (const address of addresses) {
    enqueueSessionStateNotice({ ...address, watcherStorePath, lastSeenSequence: 1 });
    await events.acknowledgeSessionStateNotices(
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
  await events.sweepSessionStateWatchNotices({ ...database, now });
  expect(peekSystemEventEntries(watcher)).toEqual([]);
  expect(readRetained()).toEqual(retained);
  for (const sessionKey of ["global", watcher, child]) {
    await events.handleSessionStateSessionReset(sessionKey, database);
    await events.handleSessionStateSessionDeleted(sessionKey, "main", database);
    expect(readRetained()).toEqual(retained);
  }
  await events.sweepSessionStateWatchNotices({
    ...database,
    now: now + 30 * 24 * 60 * 60_000 + 1,
  });
  expect(readRetained()).toEqual([]);
});
