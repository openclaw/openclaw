import { afterEach, describe, expect, it } from "vitest";
import { trackSqliteStatementExecutions } from "../../test/helpers/sqlite-statement-execution-counter.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { recordSessionStateEvent } from "./session-state-events.js";
import { recordSessionStateEventInDatabase } from "./session-state-events.kernel.js";
import {
  child,
  cleanupSessionStateTestState,
  createDatabaseOptions,
  eventInput,
  nestedWatcher,
  readCursor,
  seedChild,
} from "./session-state-events.test-support.js";

afterEach(cleanupSessionStateTestState);

describe("session state watcher cursor batches", () => {
  it("advances watcher fanout with bounded cursor reads and preserves excluded cursors", () => {
    const database = createDatabaseOptions();
    seedChild(database, nestedWatcher);
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
    let event: ReturnType<typeof recordSessionStateEvent>;
    try {
      event = recordSessionStateEvent(
        eventInput({
          actorId: actor,
          watcherSessionKeys: [watchers[0]!, missing, watchers[0]!, actor, "global", stale],
          watcherStorePaths: { [stale]: "/synthetic/retired-store.sqlite" },
        }),
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
