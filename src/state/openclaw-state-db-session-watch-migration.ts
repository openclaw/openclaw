// Schema-v4 migration for legacy ambient session-watch sentinel rows.
import type { DatabaseSync } from "node:sqlite";
import { ensureColumn, tableExists, tableHasColumn } from "./openclaw-state-db-schema-helpers.js";
import {
  SESSION_WATCH_PROVENANCE_AMBIENT_GROUP,
  SESSION_WATCH_PROVENANCE_EXPLICIT,
} from "./session-watch-cursor-provenance.js";

const SESSION_WATCH_PROVENANCE_SCHEMA_VERSION = 4;
const LEGACY_AMBIENT_GROUP_WATCH_MARKER_PREFIX = "ambient-group-watch:";
const SESSION_WATCH_PROVENANCE_COLUMN_SQL =
  `provenance TEXT NOT NULL DEFAULT '${SESSION_WATCH_PROVENANCE_EXPLICIT}' ` +
  `CHECK (provenance IN ('${SESSION_WATCH_PROVENANCE_EXPLICIT}', '${SESSION_WATCH_PROVENANCE_AMBIENT_GROUP}'))`;

type LegacyAmbientWatchMarkerRow = {
  watcher_session_key: string;
  target_session_key: string;
  updated_at: number;
};

export type SessionWatchCursorProvenanceMigrationResult = {
  addedColumn: boolean;
  migratedAmbientWatches: number;
  removedLegacySentinels: number;
};

function hasLegacyAmbientWatchSentinels(db: DatabaseSync): boolean {
  if (!tableExists(db, "session_watch_cursors")) {
    return false;
  }
  return Boolean(
    db
      .prepare(
        `SELECT 1
         FROM session_watch_cursors
         WHERE watcher_session_key LIKE ?
         LIMIT 1`,
      )
      .get(`${LEGACY_AMBIENT_GROUP_WATCH_MARKER_PREFIX}%`),
  );
}

export function needsSessionWatchCursorProvenanceMigration(
  db: DatabaseSync,
  userVersion: number,
): boolean {
  if (!tableExists(db, "session_watch_cursors")) {
    return false;
  }
  return (
    userVersion < SESSION_WATCH_PROVENANCE_SCHEMA_VERSION ||
    !tableHasColumn(db, "session_watch_cursors", "provenance") ||
    hasLegacyAmbientWatchSentinels(db)
  );
}

function decodeLegacyAmbientWatchMarkerKey(markerKey: string): string | undefined {
  const encoded = markerKey.slice(LEGACY_AMBIENT_GROUP_WATCH_MARKER_PREFIX.length);
  if (!encoded || encoded.length % 2 !== 0 || !/^[0-9a-f]+$/.test(encoded)) {
    return undefined;
  }
  return Buffer.from(encoded, "hex").toString("utf8");
}

export function migrateSessionWatchCursorProvenance(
  db: DatabaseSync,
): SessionWatchCursorProvenanceMigrationResult {
  if (!tableExists(db, "session_watch_cursors")) {
    return { addedColumn: false, migratedAmbientWatches: 0, removedLegacySentinels: 0 };
  }

  const addedColumn = ensureColumn(
    db,
    "session_watch_cursors",
    SESSION_WATCH_PROVENANCE_COLUMN_SQL,
  );
  const legacyMarkers = db
    .prepare(
      `SELECT watcher_session_key, target_session_key, updated_at
       FROM session_watch_cursors
       WHERE watcher_session_key LIKE ?`,
    )
    .all(`${LEGACY_AMBIENT_GROUP_WATCH_MARKER_PREFIX}%`) as LegacyAmbientWatchMarkerRow[];
  const promoteWatch = db.prepare(
    `UPDATE session_watch_cursors
     SET provenance = ?, updated_at = max(updated_at, ?)
     WHERE watcher_session_key = ? AND target_session_key = ?`,
  );
  const deleteMarker = db.prepare(
    `DELETE FROM session_watch_cursors
     WHERE watcher_session_key = ? AND target_session_key = ?`,
  );
  let migratedAmbientWatches = 0;
  for (const marker of legacyMarkers) {
    const watcherSessionKey = decodeLegacyAmbientWatchMarkerKey(marker.watcher_session_key);
    if (watcherSessionKey) {
      migratedAmbientWatches += Number(
        promoteWatch.run(
          SESSION_WATCH_PROVENANCE_AMBIENT_GROUP,
          marker.updated_at,
          watcherSessionKey,
          marker.target_session_key,
        ).changes,
      );
    }
    deleteMarker.run(marker.watcher_session_key, marker.target_session_key);
  }
  return {
    addedColumn,
    migratedAmbientWatches,
    removedLegacySentinels: legacyMarkers.length,
  };
}
