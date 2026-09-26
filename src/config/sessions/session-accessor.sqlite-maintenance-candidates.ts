import { toUSVString } from "node:util";
import { sql } from "kysely";
import { iterateSqliteQuerySync, sqliteStringSet } from "../../infra/kysely-sync.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { getSessionKysely } from "./session-accessor.sqlite-scope.js";
import {
  parseSessionEntryJson,
  sessionEntryMetadataJson,
} from "./session-accessor.sqlite-status.js";
import { normalizeStoreSessionKey } from "./store-entry.js";
import {
  getSessionMaintenanceActivityAt,
  shouldPreserveMaintenanceEntry,
} from "./store-maintenance.js";
import type { SessionEntry } from "./types.js";

const maintenanceFields = [
  "sessionId",
  "updatedAt",
  "archivedAt",
  "lastActivityAt",
  "lastInteractionAt",
  "sessionStartedAt",
  "status",
  "pinnedAt",
  "spawnedBy",
  "parentSessionKey",
  "modelSelectionLocked",
  "chatType",
  "delivery",
];

function maintenanceCandidates(database: Pick<OpenClawAgentDatabase, "db">) {
  // json_each preserves absent/null fields and JSON subtypes. Uncertified rows
  // keep the full parser contract, including malformed and overdepth payloads.
  const projection =
    /* kysely-allow-raw: maintenance reads only phase facts from certified rows. */ sql<string>`CASE WHEN entry_valid = 1 AND json_valid(entry_json)
    THEN (SELECT json_group_object(key, CASE type
      WHEN 'object' THEN json(value) WHEN 'array' THEN json(value)
      WHEN 'true' THEN json('true') WHEN 'false' THEN json('false')
      ELSE value END) FROM json_each(entry_json) WHERE key IN (${sql.join(maintenanceFields)}))
    ELSE ${sessionEntryMetadataJson.expression} END`.as("entry_json");
  return getSessionKysely(database.db)
    .selectFrom("session_nodes")
    .select([projection, "current_session_id", "session_key", "updated_at", "archived_at"])
    .modifyEnd(
      /* kysely-allow-raw: stream age bounds without sorting the entire active store. */
      sql`INDEXED BY idx_agent_session_nodes_updated_at`,
    );
}

export function collectSqliteSessionMaintenanceBaseKeys(
  store: Record<string, SessionEntry>,
  activeSessionKeys: Iterable<string>,
): string[] {
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const activeSessionKey of activeSessionKeys) {
    let currentKey = normalizeStoreSessionKey(activeSessionKey);
    while (currentKey && !seen.has(currentKey)) {
      seen.add(currentKey);
      keys.push(currentKey);
      currentKey = normalizeStoreSessionKey(store[currentKey]?.parentSessionKey ?? "");
    }
  }
  return keys;
}

export function readSessionMaintenanceKeyProjection(
  database: Pick<OpenClawAgentDatabase, "db">,
): Record<string, SessionEntry> {
  const db = getSessionKysely(database.db);
  const store: Record<string, SessionEntry> = {};
  for (const row of iterateSqliteQuerySync(
    database.db,
    db
      .selectFrom("session_nodes")
      .select(["current_session_id", "parent_session_key", "session_key", "updated_at"])
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
}): Record<string, SessionEntry> {
  if (params.minimumAgeMs == null || params.minimumAgeMs <= 0) {
    return {};
  }
  const db = getSessionKysely(params.database.db);
  const store: Record<string, SessionEntry> = {};
  for (const row of iterateSqliteQuerySync(
    params.database.db,
    db
      .selectFrom(maintenanceCandidates(params.database).as("candidates"))
      .selectAll()
      .where("updated_at", "<", Date.now() - params.minimumAgeMs)
      .where("archived_at", "is", null)
      .where((eb) =>
        eb.or([
          ...(params.pruneAfterMs > 0
            ? [eb("updated_at", "<", Date.now() - params.pruneAfterMs)]
            : []),
          eb("session_key", "like", "%dashboard:%"),
          eb("session_key", "like", "%model-run-%"),
        ]),
      )
      .orderBy("updated_at", "asc"),
  )) {
    const entry = parseSessionEntryJson(row);
    if (entry) {
      store[row.session_key] = entry;
    }
  }
  return store;
}

export function readSessionMaintenanceCapCandidates(params: {
  database: Pick<OpenClawAgentDatabase, "db">;
  excludedKeys: ReadonlySet<string>;
  overflow: number;
  preserveKeys?: ReadonlySet<string>;
  preserveRecentMs?: number | null;
}): Record<string, SessionEntry> {
  if (params.overflow <= 0) {
    return {};
  }
  const db = getSessionKysely(params.database.db);
  // Only push down keys unchanged by Node/SQLite text conversion; retain exact membership below.
  const excludedKeys = [...params.excludedKeys].filter(
    (key) => toUSVString(key) === key && !key.includes("\0") && !/[\uFFFE\uFFFF]/u.test(key),
  );
  const selected: Array<{
    key: string;
    keyBytes: Buffer;
    entry: SessionEntry;
    activityAt: number;
  }> = [];
  for (const row of iterateSqliteQuerySync(
    params.database.db,
    db
      .selectFrom(maintenanceCandidates(params.database).as("candidates"))
      .selectAll()
      .select(
        /* kysely-allow-raw: BINARY ties use the database encoding, including retained UTF-16 stores. */
        sql<Uint8Array>`CAST(session_key AS BLOB)`.as("key_bytes"),
      )
      .where("archived_at", "is", null)
      .$if(excludedKeys.length > 0, (query) =>
        query.where("session_key", "not in", sqliteStringSet(excludedKeys)),
      )
      .orderBy("updated_at", "asc")
      .orderBy("session_key", "desc"),
  )) {
    const keyBytes = Buffer.from(row.key_bytes);
    const worst = selected.at(-1);
    // Activity is at least updatedAt; equal lower bounds follow descending keys.
    // Once neither can improve the worst selected row, the indexed scan is done.
    if (
      selected.length === params.overflow &&
      worst &&
      (row.updated_at > worst.activityAt ||
        (row.updated_at === worst.activityAt && Buffer.compare(keyBytes, worst.keyBytes) <= 0))
    ) {
      break;
    }
    if (params.excludedKeys.has(row.session_key)) {
      continue;
    }
    const entry = parseSessionEntryJson(row);
    if (!entry || shouldPreserveMaintenanceEntry({ ...params, key: row.session_key, entry })) {
      continue;
    }
    const candidate = {
      key: row.session_key,
      keyBytes,
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
  return Object.fromEntries(
    selected
      .toSorted((left, right) => Buffer.compare(left.keyBytes, right.keyBytes))
      .map(({ key, entry }) => [key, entry]),
  );
}
