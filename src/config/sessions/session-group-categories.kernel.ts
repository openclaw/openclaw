import { readSessionGroupCatalogEntry } from "../../gateway/session-group-catalog.kernel.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { withExistingOpenClawStateDatabaseReadOnly } from "../../state/openclaw-state-db-readonly.js";
import {
  prepareExactSessionEntryRowReads,
  readExactSessionEntryRow,
  type ResolvedSessionEntryRow,
} from "./session-accessor.sqlite-entry-read.js";
import { writeSessionEntry } from "./session-accessor.sqlite-entry-store.js";

// Small groups are cheaper through the connection's already compiled point reads.
const MIN_BATCHED_CATEGORY_KEYS = 10;

export function applySessionGroupCategoryMutation(
  database: OpenClawAgentDatabase,
  keys: readonly string[],
  from: string,
  to: string | undefined,
  env: NodeJS.ProcessEnv,
): Array<{ sessionKey: string; sessionId: string }> {
  const current = new Map<string, ResolvedSessionEntryRow>();
  const readPrepared =
    keys.length >= MIN_BATCHED_CATEGORY_KEYS
      ? prepareExactSessionEntryRowReads(database, keys)
      : undefined;
  for (const key of keys) {
    const row = readPrepared ? readPrepared(key) : readExactSessionEntryRow(database, key);
    if (row?.entry.category?.trim() === from) {
      current.set(key, row);
    }
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

function assertSessionGroupCategoryDestination(
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
