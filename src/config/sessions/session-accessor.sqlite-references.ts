import { toUSVString } from "node:util";
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { sql } from "kysely";
import {
  executeSqliteQuerySync,
  iterateSqliteQuerySync,
  sqliteStringSet,
} from "../../infra/kysely-sync.js";
import { isPostgresSqlConnection } from "../../infra/sql-connection.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { readLegacyCompactionHistory } from "./legacy-compaction-history.js";
import {
  sessionReferenceAtomPath,
  sessionReferenceAtoms,
  sessionReferenceProjection,
  usableSessionReferenceProjection,
} from "./session-accessor.sqlite-reference-projection.js";
import { getSessionKysely } from "./session-accessor.sqlite-scope-helpers.js";
import { parseSessionEntryJson } from "./session-accessor.sqlite-status.js";
import { isSessionEntryDiskBudgetEvictable } from "./store-maintenance.js";
import type { SessionEntry } from "./types.js";

/** Every transcript generation retained by one canonical logical-session record. */
export function collectSessionStateIdsForEntry(entry: SessionEntry): string[] {
  const sessionIds: string[] = [];
  const add = (sessionId: string | undefined) => {
    const normalized = sessionId?.trim();
    if (normalized) {
      sessionIds.push(normalized);
    }
  };
  add(entry.sessionId);
  add(entry.previousSessionId);
  for (const sessionId of entry.usageFamilySessionIds ?? []) {
    add(sessionId);
  }
  for (const checkpoint of readLegacyCompactionHistory(entry)) {
    add(checkpoint.sessionId);
    add(checkpoint.preCompaction.sessionId);
    add(checkpoint.postCompaction.sessionId);
  }
  return uniqueStrings(sessionIds);
}

/** Retained logical owners protect generations absent from their entry references. */
function addRetainedWindowSessionReferences(
  database: Pick<OpenClawAgentDatabase, "db">,
  sessionIds: Set<string>,
  excludedSessionKeys: ReadonlySet<string>,
  candidateSessionIds?: readonly string[],
  diskBudget?: { preserveRecentMs?: number | null },
): void {
  const db = getSessionKysely(database.db);
  // Explicit reset/delete excludes its target owner. Automatic deletion rechecks
  // window ownership inside the commit after archive materialization has awaited.
  let query = db
    .selectFrom("session_windows")
    .innerJoin("session_nodes", "session_nodes.session_key", "session_windows.session_key")
    .select([
      "session_windows.session_id",
      "session_nodes.session_key",
      "session_nodes.current_session_id",
      "session_nodes.updated_at",
      "session_nodes.pinned_at",
    ])
    .$if(diskBudget !== undefined, (projection) => projection.select("session_nodes.entry_json"))
    .where((eb) =>
      eb.or([
        eb("session_nodes.archived_at", "is not", null),
        eb("session_nodes.pinned_at", "is not", null),
      ]),
    );
  if (candidateSessionIds) {
    query = query.where("session_windows.session_id", "in", sqliteStringSet(candidateSessionIds));
  }
  for (const row of iterateSqliteQuerySync(database.db, query)) {
    if (excludedSessionKeys.has(row.session_key)) {
      continue;
    }
    // Only the physical-budget owner may reclaim cap-created history. Node references
    // (including the current generation) remain protected until its final entry tier.
    if (
      diskBudget &&
      row.pinned_at === null &&
      row.entry_json !== undefined &&
      isSessionEntryDiskBudgetEvictable({
        key: row.session_key,
        entry: parseSessionEntryJson({ ...row, entry_json: row.entry_json }) ?? undefined,
        preserveRecentMs: diskBudget.preserveRecentMs,
      })
    ) {
      continue;
    }
    sessionIds.add(row.session_id);
  }
}

/** Session ids protected by live node state. */
export function readReferencedSessionIds(
  database: Pick<OpenClawAgentDatabase, "db">,
  excludedSessionKeys: ReadonlySet<string> = new Set(),
  candidateSessionIds?: readonly string[],
  diskBudget?: { preserveRecentMs?: number | null },
): Set<string> {
  if (candidateSessionIds?.length === 0) {
    return new Set();
  }
  const db = getSessionKysely(database.db);
  const postgres = isPostgresSqlConnection(database.db);
  // Only push down keys unchanged by Node/SQLite text conversion; retain exact membership below.
  const excludedKeys = [...excludedSessionKeys].filter(
    (key) => toUSVString(key) === key && !key.includes("\0") && !/[\uFFFE\uFFFF]/u.test(key),
  );
  let query = db
    .selectFrom("session_nodes")
    .select(["current_session_id", "session_key"])
    .$if(excludedKeys.length > 0, (builder) =>
      builder.where("session_key", "not in", sqliteStringSet(excludedKeys)),
    );
  // Narrow all target IDs together. Optional/malformed references stay eligible
  // for the projection or raw fallback, including escaped and duplicate keys.
  // Bulk plans scan once instead of comparing each surviving row with every candidate.
  if (
    candidateSessionIds?.length &&
    candidateSessionIds.length <= 16 &&
    candidateSessionIds.every(
      (candidate) => toUSVString(candidate) === candidate && !/[\0\uFFFD-\uFFFF]/u.test(candidate),
    )
  ) {
    query = query.where((eb) =>
      eb.or([
        eb.or(
          candidateSessionIds.map((candidate) =>
            postgres
              ? /* kysely-allow-raw: PostgreSQL substring narrowing retains trimmed current IDs. */ sql<boolean>`strpos(current_session_id, ${candidate}) > 0`
              : /* kysely-allow-raw: substring narrowing retains trimmed current IDs. */ sql<boolean>`instr(current_session_id, ${candidate}) > 0`,
          ),
        ),
        eb("has_optional_references", "=", 1),
      ]),
    );
  }
  const referenceQuery = db
    .with(
      (cte) => cte("projected_nodes").materialized(),
      () => query.select(sessionReferenceProjection),
    )
    .with(
      (cte) => cte("reference_nodes").materialized(),
      (builder) =>
        builder.selectFrom("projected_nodes").selectAll().select(usableSessionReferenceProjection),
    )
    .selectFrom("reference_nodes")
    .leftJoin(sessionReferenceAtoms, (join) => join.on(sessionReferenceAtomPath))
    .select(["current_session_id", "session_key", "reference.atom", "reference.fullkey"])
    .select(
      /* kysely-allow-raw: only exceptional rows cross into JS as entry JSON. */ sql<
        string | null
      >`CASE WHEN "references" IS NULL THEN (SELECT entry_json FROM session_nodes WHERE session_nodes.session_key = reference_nodes.session_key) END`.as(
        "entry_json",
      ),
    );
  // PostgreSQL uses the canonical entry parser; the native JSON projection is SQLite-specific.
  const rows = iterateSqliteQuerySync(
    database.db,
    postgres
      ? query.select((eb) => ["entry_json", eb.val(null).as("atom"), eb.val(null).as("fullkey")])
      : referenceQuery,
  );
  const sessionIds = new Set<string>();
  const candidates = candidateSessionIds ? new Set(candidateSessionIds) : undefined;
  const addReference = (sessionId: string) => {
    if (!candidates || candidates.has(sessionId)) {
      sessionIds.add(sessionId);
    }
  };
  for (const row of rows) {
    if (excludedSessionKeys.has(row.session_key)) {
      continue;
    }
    addReference(row.current_session_id);
    if (row.entry_json !== null) {
      const entry = parseSessionEntryJson({ ...row, entry_json: row.entry_json });
      if (entry) {
        for (const sessionId of collectSessionStateIdsForEntry(entry)) {
          addReference(sessionId);
        }
      }
    } else if (
      row.atom !== null &&
      row.fullkey !== null &&
      /^\$\.(sessionId|previousSessionId|usageFamilySessionIds\[\d+\]|compactionCheckpoints\[\d+\]\.(sessionId|(?:preCompaction|postCompaction)\.sessionId))$/u.test(
        row.fullkey,
      )
    ) {
      const sessionId = row.atom.trim();
      if (sessionId) {
        addReference(sessionId);
      }
    }
  }
  addRetainedWindowSessionReferences(
    database,
    sessionIds,
    excludedSessionKeys,
    candidateSessionIds,
    diskBudget,
  );
  return candidateSessionIds
    ? new Set(candidateSessionIds.filter((sessionId) => sessionIds.has(sessionId)))
    : sessionIds;
}

// Projects references after a lifecycle mutation so reset/delete can archive
// before removing entry rows while still preserving shared session ids.
export function readReferencedSessionIdsAfterTargetMutation(
  database: OpenClawAgentDatabase,
  target: { canonicalKey: string; storeKeys: string[] },
  candidateSessionIds: readonly string[],
): Set<string> {
  const removedKeys = new Set(
    uniqueStrings([target.canonicalKey, ...target.storeKeys].map((key) => key.trim())),
  );
  return readReferencedSessionIds(database, removedKeys, candidateSessionIds);
}

/** Ids of every persisted generation owned by the given logical session keys. */
export function readSessionGenerationIdsForKeys(
  database: OpenClawAgentDatabase,
  keys: Iterable<string>,
  options: { exactStoredKeys?: boolean } = {},
): string[] {
  const sessionKeys = [...keys].map((key) => (options.exactStoredKeys ? key : key.trim()));
  if (sessionKeys.length === 0) {
    return [];
  }
  const db = getSessionKysely(database.db);
  return executeSqliteQuerySync(
    database.db,
    db
      .selectFrom("session_windows")
      .select("session_id")
      .where("session_key", "in", sqliteStringSet(sessionKeys)),
  ).rows.map((row) => row.session_id);
}

// Projected deletes must preserve raw session_nodes.current_session_id references for
// remaining rows whose entry_json cannot be parsed into a SessionEntry.
export function collectProjectedReferencedSessionIds(params: {
  database: Pick<OpenClawAgentDatabase, "db">;
  excludedSessionKeys: Iterable<string>;
  projectedStore: Record<string, SessionEntry>;
  candidateSessionIds?: readonly string[];
}): Set<string> {
  const excludedSessionKeys = new Set(params.excludedSessionKeys);
  const sessionIds = readReferencedSessionIds(
    params.database,
    excludedSessionKeys,
    params.candidateSessionIds,
  );
  for (const entry of Object.values(params.projectedStore)) {
    for (const sessionId of collectSessionStateIdsForEntry(entry)) {
      sessionIds.add(sessionId);
    }
  }
  return sessionIds;
}
