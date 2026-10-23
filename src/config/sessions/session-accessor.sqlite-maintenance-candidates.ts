import { toUSVString } from "node:util";
import { sql } from "kysely";
import { engineIndexHint } from "../../infra/database-engine/index-hint.js";
import { jsonPickObject, jsonValid } from "../../infra/database-engine/json-values.js";
import { iterateSqliteQuerySync, sqliteStringSet } from "../../infra/kysely-sync.js";
import { isPostgresSqlConnection } from "../../infra/sql-connection.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { getSessionKysely } from "./session-accessor.sqlite-scope.js";
import { parseSessionEntryJson } from "./session-accessor.sqlite-status.js";
import { normalizeStoreSessionKey } from "./store-entry.js";
import { getSessionMaintenanceActivityAt } from "./store-maintenance-activity.js";
import { shouldPreserveMaintenanceEntry } from "./store-maintenance.js";
import type { SessionEntry } from "./types.js";

const maintenanceFields = [
  "sessionId",
  "updatedAt",
  "archivedAt",
  "lastActivityAt",
  "lastInteractionAt",
  "sessionStartedAt",
  "pinnedAt",
  "sidebarRoot",
  "spawnedBy",
  "parentSessionKey",
  "modelSelectionLocked",
  "mainRestartRecovery",
  "restartRecoveryRuns",
  "restartRecoveryTerminalRunIds",
  "restartRecoveryDeliveryRunId",
  "pendingFinalDelivery",
  "chatType",
  "delivery",
];

function maintenanceCandidates(database: Pick<OpenClawAgentDatabase, "db">) {
  const entryJson =
    /* kysely-allow-raw: Fixed column shared by the JSON projections. */ sql.ref("entry_json");
  // json_each preserves absent/null fields and JSON subtypes. Uncertified rows
  // keep the full parser contract, including malformed and overdepth payloads.
  const projection = (
    isPostgresSqlConnection(database.db)
      ? /* kysely-allow-raw: Certified JSON projection uses the selected engine's operators. */ sql<string>`CASE WHEN entry_valid = 1 AND ${jsonValid(database.db, entryJson)}
    THEN ${jsonPickObject(database.db, entryJson, maintenanceFields)} ELSE entry_json END`
      : /* kysely-allow-raw: maintenance reads only phase facts from certified rows. */ sql<string>`CASE WHEN entry_valid = 1 AND json_valid(entry_json)
    THEN (SELECT json_group_object(key, CASE type
      WHEN 'object' THEN json(value) WHEN 'array' THEN json(value)
      WHEN 'true' THEN json('true') WHEN 'false' THEN json('false')
      ELSE value END) FROM json_each(entry_json) WHERE key IN (${sql.join(maintenanceFields)}))
    ELSE entry_json END`
  ).as("entry_json");
  return getSessionKysely(database.db)
    .selectFrom("session_nodes")
    .select([projection, "current_session_id", "session_key", "updated_at", "archived_at"])
    .modifyEnd(engineIndexHint(database.db, "idx_agent_session_nodes_updated_at"));
}

export function collectSqliteSessionMaintenanceBaseKeys(
  readProjection: (sessionKeys: readonly string[]) => Record<string, SessionEntry>,
  activeSessionKeys: Iterable<string>,
  baseKeys: readonly string[] = [],
): string[] {
  const keys = new Set(baseKeys);
  let pending = [...activeSessionKeys];
  while (pending.length > 0) {
    pending = [...new Set(pending.map(normalizeStoreSessionKey))].filter(
      (key) => key && !keys.has(key),
    );
    if (pending.length === 0) {
      break;
    }
    pending.forEach((key) => keys.add(key));
    const projection = readProjection(pending);
    pending = pending.flatMap((key) => {
      const parent = projection[key]?.parentSessionKey;
      return parent ? [parent] : [];
    });
  }
  return [...keys];
}

export function readSessionMaintenanceKeyProjection(
  database: Pick<OpenClawAgentDatabase, "db">,
  sessionKeys?: readonly string[],
): Record<string, SessionEntry> {
  const db = getSessionKysely(database.db);
  const store: Record<string, SessionEntry> = {};
  for (const row of iterateSqliteQuerySync(
    database.db,
    db
      .selectFrom("session_nodes")
      .select(["current_session_id", "parent_session_key", "session_key", "updated_at"])
      .$if(sessionKeys !== undefined, (query) =>
        query.where("session_key", "in", sqliteStringSet(sessionKeys ?? [])),
      )
      .where("archived_at", "is", null)
      .orderBy("session_key", "asc"),
  )) {
    store[row.session_key] = {
      sessionId: row.current_session_id,
      updatedAt: row.updated_at,
      ...(row.parent_session_key ? { parentSessionKey: row.parent_session_key } : {}),
    };
  }
  return store;
}

export function readSessionMaintenanceAgeCandidates(params: {
  database: Pick<OpenClawAgentDatabase, "db">;
  minimumAgeMs: number | null;
  pruneAfterMs: number;
  archiveDashboardAfterMs: number | null;
  modelRunPruneAfterMs: number | null;
  limit?: number;
  nowMs?: number;
  after?: { updatedAt: number; sessionKey: string };
}): { store: Record<string, SessionEntry>; last?: { updatedAt: number; sessionKey: string } } {
  if (params.minimumAgeMs == null || params.minimumAgeMs <= 0) {
    return { store: {} };
  }
  const db = getSessionKysely(params.database.db);
  const store: Record<string, SessionEntry> = {};
  const now = params.nowMs ?? Date.now();
  let last: { updatedAt: number; sessionKey: string } | undefined;
  for (const row of iterateSqliteQuerySync(
    params.database.db,
    db
      .selectFrom(maintenanceCandidates(params.database).as("candidates"))
      .selectAll()
      .where("updated_at", "<", now - params.minimumAgeMs)
      .where("archived_at", "is", null)
      .where((eb) =>
        eb.or([
          ...(params.pruneAfterMs > 0 ? [eb("updated_at", "<", now - params.pruneAfterMs)] : []),
          ...(params.archiveDashboardAfterMs != null && params.archiveDashboardAfterMs > 0
            ? [
                eb.and([
                  eb("session_key", "like", "%dashboard:%"),
                  eb("updated_at", "<", now - params.archiveDashboardAfterMs),
                ]),
              ]
            : []),
          ...(params.modelRunPruneAfterMs != null && params.modelRunPruneAfterMs > 0
            ? [
                eb.and([
                  eb("session_key", "like", "%model-run-%"),
                  eb("updated_at", "<", now - params.modelRunPruneAfterMs),
                ]),
              ]
            : []),
        ]),
      )
      .$if(params.after !== undefined, (query) =>
        query.where((eb) =>
          eb.or([
            eb("updated_at", ">", params.after!.updatedAt),
            eb.and([
              eb("updated_at", "=", params.after!.updatedAt),
              eb("session_key", ">", params.after!.sessionKey),
            ]),
          ]),
        ),
      )
      .orderBy("updated_at", "asc")
      .orderBy("session_key", "asc")
      .$if(params.limit !== undefined, (query) => query.limit(params.limit!)),
  )) {
    last = { updatedAt: row.updated_at, sessionKey: row.session_key };
    const entry = parseSessionEntryJson(row);
    if (entry) {
      store[row.session_key] = entry;
    }
  }
  return { store, last };
}

export function readSessionMaintenanceCapCandidates(params: {
  database: Pick<OpenClawAgentDatabase, "db">;
  activeSessionKeys: readonly string[];
  excludedKeys: ReadonlySet<string>;
  overflow: number;
  readPreserveKeys: () => ReadonlySet<string> | undefined;
  preserveRecentMs?: number | null;
  nowMs?: number;
}): { store: Record<string, SessionEntry>; durableNoCandidates: boolean } {
  if (params.overflow <= 0) {
    return { store: {}, durableNoCandidates: false };
  }
  const db = getSessionKysely(params.database.db);
  const activeKeys = new Set(
    params.activeSessionKeys.map(normalizeStoreSessionKey).filter(Boolean),
  );
  // Only push down keys unchanged by Node/SQLite text conversion; retain exact membership below.
  const excludedKeys = [...params.excludedKeys].filter(
    (key) => toUSVString(key) === key && !key.includes("\0") && !/[\uFFFE\uFFFF]/u.test(key),
  );
  const selected: Array<{
    key: string;
    keyBytes: Uint8Array;
    entry: SessionEntry;
    activityAt: number;
  }> = [];
  let durableNoCandidates = true;
  for (const row of iterateSqliteQuerySync(
    params.database.db,
    db
      .selectFrom(maintenanceCandidates(params.database).as("candidates"))
      .selectAll()
      .select(
        (isPostgresSqlConnection(params.database.db)
          ? /* kysely-allow-raw: PostgreSQL text keys use UTF-8 byte order. */ sql<Uint8Array>`convert_to(session_key, 'UTF8')`
          : /* kysely-allow-raw: Preserve native encoding, including retained UTF-16 stores. */ sql<Uint8Array>`CAST(session_key AS BLOB)`
        ).as("key_bytes"),
      )
      .where("archived_at", "is", null)
      .$if(excludedKeys.length > 0, (query) =>
        query.where("session_key", "not in", sqliteStringSet(excludedKeys)),
      )
      .orderBy("updated_at", "asc")
      .orderBy("session_key", "desc"),
  )) {
    const worst = selected.at(-1);
    // Activity is at least updatedAt; equal lower bounds follow descending keys.
    // Once neither can improve the worst selected row, the indexed scan is done.
    if (
      selected.length === params.overflow &&
      worst &&
      (row.updated_at > worst.activityAt ||
        (row.updated_at === worst.activityAt && Buffer.compare(row.key_bytes, worst.keyBytes) <= 0))
    ) {
      break;
    }
    if (params.excludedKeys.has(row.session_key)) {
      continue;
    }
    const entry = parseSessionEntryJson(row);
    if (!entry) {
      durableNoCandidates = false;
      continue;
    }
    if (shouldPreserveMaintenanceEntry({ key: row.session_key, entry, preserveRecentMs: null })) {
      continue;
    }
    // Intrinsic protection needs no runtime snapshot; runtime/recent protection can end on its own.
    durableNoCandidates = false;
    if (
      activeKeys.has(row.session_key) ||
      shouldPreserveMaintenanceEntry({
        key: row.session_key,
        entry,
        preserveKeys: params.readPreserveKeys(),
        preserveRecentMs: params.preserveRecentMs,
        nowMs: params.nowMs,
      })
    ) {
      continue;
    }
    const candidate = {
      key: row.session_key,
      keyBytes: row.key_bytes,
      entry,
      activityAt: getSessionMaintenanceActivityAt(entry),
    };
    let left = 0;
    let right = selected.length;
    while (left < right) {
      const middle = (left + right) >>> 1;
      const current = selected[middle]!;
      const order =
        candidate.activityAt - current.activityAt ||
        Buffer.compare(current.keyBytes, candidate.keyBytes);
      if (order < 0) {
        right = middle;
      } else {
        left = middle + 1;
      }
    }
    if (left < params.overflow) {
      selected.splice(left, 0, candidate);
      if (selected.length > params.overflow) {
        selected.pop();
      }
    }
  }
  // The phase owner reverses this original SQLite key order to resolve activity ties.
  return {
    store: Object.fromEntries(
      selected
        .toSorted((left, right) => Buffer.compare(left.keyBytes, right.keyBytes))
        .map(({ key, entry }) => [key, entry]),
    ),
    durableNoCandidates,
  };
}
