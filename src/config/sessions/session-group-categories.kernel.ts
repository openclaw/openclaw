import { readSessionGroupCatalogEntry } from "../../gateway/session-group-catalog.kernel.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { withExistingOpenClawStateDatabaseReadOnly } from "../../state/openclaw-state-db-readonly.js";
import { sqliteSessionEntriesEqual } from "./session-accessor.sqlite-entry-equality.js";
import {
  readExactSessionEntryRow,
  type ResolvedSessionEntryRow,
} from "./session-accessor.sqlite-entry-read.js";
import { writeSessionEntry } from "./session-accessor.sqlite-entry-store.js";
import { readSessionGroupCategoryKeys } from "./session-group-categories.read.js";

export function prepareSessionGroupCategoryMutation(
  database: OpenClawAgentDatabase,
  name: string,
): Map<string, ResolvedSessionEntryRow> {
  const rows = new Map<string, ResolvedSessionEntryRow>();
  for (const key of readSessionGroupCategoryKeys(database, name)) {
    const row = readExactSessionEntryRow(database, key);
    if (row?.entry.category?.trim() === name) {
      rows.set(key, row);
    }
  }
  return rows;
}

export function applySessionGroupCategoryMutation(
  database: OpenClawAgentDatabase,
  expected: ReadonlyMap<string, ResolvedSessionEntryRow>,
  to: string | undefined,
  env: NodeJS.ProcessEnv,
): Array<{ sessionKey: string; sessionId: string }> {
  const current = new Map<string, ResolvedSessionEntryRow>();
  for (const [key, before] of expected) {
    const row = readExactSessionEntryRow(database, key);
    if (
      !row ||
      row.row.entry_json !== before.row.entry_json ||
      !sqliteSessionEntriesEqual(row.entry, before.entry)
    ) {
      throw new Error(`SQLite session entry changed before replacement for ${key}`);
    }
    current.set(key, row);
  }
  assertSessionGroupCategoryDestination(to, env);
  for (const [key, row] of current) {
    const next = { ...row.entry };
    if (to === undefined) {
      delete next.category;
    } else {
      next.category = to;
    }
    writeSessionEntry(database, key, next, {
      canonicalPreviousEntry: row.entry,
      previousEntry: row.entry,
    });
  }
  return [...current].map(([sessionKey, { entry }]) => ({
    sessionKey,
    sessionId: entry.sessionId,
  }));
}

export function assertSessionGroupCategoryDestination(
  to: string | undefined,
  env: NodeJS.ProcessEnv,
): void {
  if (
    to !== undefined &&
    !withExistingOpenClawStateDatabaseReadOnly(({ db }) => readSessionGroupCatalogEntry(db, to), {
      env,
    })
  ) {
    throw new Error(`unknown session group: ${to}`);
  }
}
