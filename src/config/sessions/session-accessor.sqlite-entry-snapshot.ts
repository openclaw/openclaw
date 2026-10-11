import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import type { SqliteLifecycleTargetSnapshot } from "./session-accessor.sqlite-entry-equality.js";
import {
  readExactSessionEntryRow,
  readSessionEntryRowScan,
  type ResolvedSessionEntryRow,
} from "./session-accessor.sqlite-entry-read.js";
import type {
  SessionEntryWindowFacts,
  SessionEntryWindowRow,
} from "./session-accessor.sqlite-provenance.js";
import type { InternalSessionEntry as SessionEntry } from "./types.js";

/** Exact reads already own nested values; retain them through identity publication. */
export function readSessionIdentitySnapshot(
  database: OpenClawAgentDatabase,
  sessionKeys: Iterable<string>,
): Map<string, SessionEntry> {
  const snapshot = new Map<string, SessionEntry>();
  for (const sessionKey of uniqueStrings([...sessionKeys].map((key) => key.trim()))) {
    const row = readExactSessionEntryRow(database, sessionKey);
    if (row) {
      snapshot.set(sessionKey, row.entry);
    }
  }
  return snapshot;
}

// Runtime patches own only the exact canonical row. Folded lookup candidates
// can be distinct case-sensitive rooms and must not join its mutation snapshot.
export function readSessionEntrySelectionSnapshot(
  database: OpenClawAgentDatabase,
  sessionKey: string,
  exact: boolean,
  includeWindowFacts?: true,
): SqliteLifecycleTargetSnapshot {
  const scanned = exact
    ? undefined
    : readSessionEntryRowScan(database, sessionKey, includeWindowFacts);
  const selected = exact
    ? readExactSessionEntryRow(database, sessionKey, "full", undefined, includeWindowFacts)
    : scanned?.selected;
  return selected ? [captureSessionEntrySnapshot(selected)] : [];
}

export function captureSessionEntrySnapshot(
  selected: ResolvedSessionEntryRow,
): SqliteLifecycleTargetSnapshot[number] {
  let window: SessionEntryWindowFacts | undefined;
  if (selected.row.window_json !== undefined) {
    const row = selected.row.window_json
      ? (JSON.parse(selected.row.window_json) as SessionEntryWindowRow) // SAFETY: The window-column SQL projection or actor.window produces this JSON.
      : null;
    window = { sessionId: selected.row.current_session_id, row };
  }
  return {
    entry: selected.entry,
    sessionKey: selected.row.session_key,
    ...(window ? { row: selected.row } : {}),
    ...(window ? { window } : {}),
    ...(selected.row.member_ids_json !== undefined && selected.row.board_present !== undefined
      ? {
          sideTables: {
            memberIdsJson: selected.row.member_ids_json,
            hasBoard: selected.row.board_present === 1,
          },
        }
      : {}),
  };
}
