// Session-watch provenance migration: legacy sentinel marker decoding.
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { migrateSessionWatchCursorProvenance } from "./openclaw-state-db-session-watch-migration.js";

function createLegacySessionWatchTable(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE session_watch_cursors (
      watcher_session_key TEXT NOT NULL,
      target_session_key TEXT NOT NULL,
      last_seen_sequence INTEGER NOT NULL DEFAULT 0,
      notified_sequence INTEGER NOT NULL DEFAULT 0,
      material_sequence INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (watcher_session_key, target_session_key)
    ) STRICT;
  `);
}

function seedCursor(db: DatabaseSync, watcherSessionKey: string, updatedAt: number): void {
  db.prepare(`
    INSERT INTO session_watch_cursors (watcher_session_key, target_session_key, updated_at)
    VALUES (?, 't-1', ?);
  `).run(watcherSessionKey, updatedAt);
}

function readProvenance(db: DatabaseSync, watcherSessionKey: string): string | undefined {
  const row = db
    .prepare(
      "SELECT provenance FROM session_watch_cursors WHERE watcher_session_key = ? AND target_session_key = 't-1'",
    )
    .get(watcherSessionKey) as { provenance: string } | undefined;
  return row?.provenance;
}

describe("migrateSessionWatchCursorProvenance", () => {
  it("promotes the cursor row for a valid legacy sentinel marker", () => {
    const db = new DatabaseSync(":memory:");
    createLegacySessionWatchTable(db);
    seedCursor(db, "watcher-1", 5);
    const marker = `ambient-group-watch:${Buffer.from("watcher-1", "utf8").toString("hex")}`;
    seedCursor(db, marker, 9);

    const result = migrateSessionWatchCursorProvenance(db);

    expect(result).toEqual({
      addedColumn: true,
      migratedAmbientWatches: 1,
      removedLegacySentinels: 1,
    });
    expect(readProvenance(db, "watcher-1")).toBe("ambient-group");
    expect(readProvenance(db, marker)).toBeUndefined();
    db.close();
  });

  it("does not promote a row when the legacy sentinel marker is not valid UTF-8", () => {
    const db = new DatabaseSync(":memory:");
    createLegacySessionWatchTable(db);
    seedCursor(db, "�", 5);
    // 0xFF is not valid UTF-8; a forgiving decode would collide with the
    // literal U+FFFD key above and promote a row the marker never owned.
    seedCursor(db, "ambient-group-watch:ff", 9);

    const result = migrateSessionWatchCursorProvenance(db);

    expect(result.migratedAmbientWatches).toBe(0);
    expect(result.removedLegacySentinels).toBe(1);
    expect(readProvenance(db, "�")).toBe("explicit");
    expect(readProvenance(db, "ambient-group-watch:ff")).toBeUndefined();
    db.close();
  });
});
