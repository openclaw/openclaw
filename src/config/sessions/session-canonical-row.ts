import { parseAgentSessionKey } from "../../routing/session-key.js";
import { parseSqliteSessionEntryRecord } from "./session-entry-json.js";
import { projectCanonicalSessionEntryShape } from "./store-entry-shape.js";
import {
  normalizeStoreSessionKey,
  resolveDeliveryProvenCanonicalSessionKey,
} from "./store-entry.js";
import type { SessionEntry } from "./types.js";

export type CanonicalSessionValidationRow = {
  session_key: string;
  current_session_id: string;
  entry_valid: number;
  entry_json: string;
  parent_session_key: string | null;
  spawned_by: string | null;
  fork_source_session_key: string | null;
  retained_window_id: string | null;
};

export class SessionCanonicalKeyMigrationRequiredError extends Error {
  readonly code = "SESSION_CANONICAL_KEY_MIGRATION_REQUIRED";
  constructor(detail: string) {
    super(`${detail}; stop the Gateway and run openclaw doctor --fix`);
    this.name = "SessionCanonicalKeyMigrationRequiredError";
  }
}

export function canonicalSessionKeyMigrationRequiredError(
  detail: string,
): SessionCanonicalKeyMigrationRequiredError {
  return new SessionCanonicalKeyMigrationRequiredError(detail);
}

/** One validator serves full Doctor scans, pending rows, and final writer certification. */
export function validateCanonicalSessionRow(
  row: CanonicalSessionValidationRow,
): SessionEntry | undefined {
  if (
    row.entry_json === "{}" &&
    row.entry_valid === -1 &&
    row.retained_window_id === row.current_session_id
  ) {
    return undefined;
  }
  const record =
    row.entry_valid === 1
      ? parseSqliteSessionEntryRecord({
          entry_json: row.entry_json,
          current_session_id: row.current_session_id,
        })
      : null;
  if (!record) {
    throw canonicalSessionKeyMigrationRequiredError(
      `invalid persisted session row requires repair for ${row.session_key}`,
    );
  }
  const entry = projectCanonicalSessionEntryShape(record);
  if (
    (row.parent_session_key ?? undefined) !==
      (entry.parentSessionKey ?? entry.spawnedBy ?? undefined) ||
    (row.spawned_by ?? undefined) !== (entry.spawnedBy ?? undefined) ||
    (row.fork_source_session_key ?? undefined) !== (entry.forkSource?.sessionKey ?? undefined)
  ) {
    throw canonicalSessionKeyMigrationRequiredError(
      `invalid persisted session row requires repair for ${row.session_key}`,
    );
  }
  const deliveryCanonicalKey = resolveDeliveryProvenCanonicalSessionKey(row.session_key, entry);
  if (deliveryCanonicalKey !== row.session_key) {
    throw canonicalSessionKeyMigrationRequiredError(
      `non-canonical persisted row resolves to session key ${deliveryCanonicalKey}`,
    );
  }
  const trimmed = row.session_key.trim();
  const parsed = parseAgentSessionKey(trimmed);
  if (
    row.session_key !== trimmed ||
    normalizeStoreSessionKey(trimmed) !== trimmed ||
    (!parsed && trimmed !== "global" && trimmed !== "unknown")
  ) {
    throw canonicalSessionKeyMigrationRequiredError(
      `non-canonical persisted row resolves to session key ${trimmed || row.session_key}`,
    );
  }
  for (const lineageKey of [row.parent_session_key, row.spawned_by, row.fork_source_session_key]) {
    if (!lineageKey) {
      continue;
    }
    const normalized = normalizeStoreSessionKey(lineageKey);
    const lineageParsed = parseAgentSessionKey(normalized);
    if (
      normalized !== lineageKey ||
      (!lineageParsed && normalized !== "global" && normalized !== "unknown")
    ) {
      throw canonicalSessionKeyMigrationRequiredError(
        `non-canonical persisted row resolves to session key ${normalized || lineageKey}`,
      );
    }
  }
  return entry;
}
