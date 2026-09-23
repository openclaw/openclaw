import { executeSqliteQuerySync } from "../../infra/kysely-sync.js";
import {
  openOpenClawAgentDatabase,
  type OpenClawAgentDatabaseOptions,
} from "../../state/openclaw-agent-db.js";
import { getSessionKysely } from "./session-accessor.sqlite-scope.js";
import { parseSessionEntryJson } from "./session-accessor.sqlite-status.js";
import { isSessionEntryDiskBudgetEvictable } from "./store-maintenance.js";
import type { SessionEntry } from "./types.js";

type DiskEvictableArchivedSession = {
  archivedAt: number;
  entry: SessionEntry;
  sessionKey: string;
};

const DISK_EVICTABLE_ARCHIVE_BATCH_SIZE = 64;

export function readDiskEvictableArchivedSessionBatch(params: {
  after?: { archivedAt: number; sessionKey: string };
  databaseOptions: OpenClawAgentDatabaseOptions;
  limit?: number;
  preserveRecentMs?: number | null;
}): {
  candidates: DiskEvictableArchivedSession[];
  cursor?: { archivedAt: number; sessionKey: string };
  exhausted: boolean;
} {
  const limit = Math.max(1, params.limit ?? DISK_EVICTABLE_ARCHIVE_BATCH_SIZE);
  const candidates: DiskEvictableArchivedSession[] = [];
  let cursor = params.after;
  while (candidates.length < limit) {
    // The agent DB cache may evict idle handles across the caller's async deletion/measurement.
    // Reopen for each bounded page instead of retaining a Kysely handle across those awaits.
    const database = openOpenClawAgentDatabase(params.databaseOptions);
    const db = getSessionKysely(database.db);
    let query = db
      .selectFrom("session_nodes")
      .select(["archived_at", "current_session_id", "entry_json", "session_key", "updated_at"])
      .where("archived_at", "is not", null)
      .orderBy("archived_at", "asc")
      .orderBy("session_key", "asc")
      .limit(DISK_EVICTABLE_ARCHIVE_BATCH_SIZE);
    if (cursor) {
      const after = cursor;
      query = query.where((eb) =>
        eb.or([
          eb("archived_at", ">", after.archivedAt),
          eb.and([
            eb("archived_at", "=", after.archivedAt),
            eb("session_key", ">", after.sessionKey),
          ]),
        ]),
      );
    }
    const rows = executeSqliteQuerySync(database.db, query).rows;
    let scanned = 0;
    for (const row of rows) {
      scanned += 1;
      if (row.archived_at == null) {
        continue;
      }
      cursor = { archivedAt: row.archived_at, sessionKey: row.session_key };
      const entry = parseSessionEntryJson(row);
      if (
        entry &&
        isSessionEntryDiskBudgetEvictable({
          key: row.session_key,
          entry,
          preserveRecentMs: params.preserveRecentMs,
        })
      ) {
        candidates.push({ archivedAt: row.archived_at, entry, sessionKey: row.session_key });
        if (candidates.length >= limit) {
          break;
        }
      }
    }
    const exhausted = rows.length < DISK_EVICTABLE_ARCHIVE_BATCH_SIZE && scanned === rows.length;
    if (candidates.length >= limit || exhausted) {
      return { candidates, ...(cursor ? { cursor } : {}), exhausted };
    }
  }
  return { candidates, ...(cursor ? { cursor } : {}), exhausted: false };
}
