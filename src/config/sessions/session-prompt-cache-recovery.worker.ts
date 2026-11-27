import { executeSqliteQuerySync } from "../../infra/kysely-sync.js";
import { sqlPublicationAnchor } from "../../infra/sql-connection.js";
import { withSqlitePostCommitPublications } from "../../infra/sqlite-post-commit.js";
import { runSqliteReadSnapshotSync } from "../../infra/sqlite-transaction.js";
import { isPromptCacheRecoveryCandidate } from "../../sessions/prompt-cache-recovery.js";
import type { OpenClawAgentReadOnlyDatabase } from "../../state/openclaw-agent-db-readonly.js";
import { isInternalSessionEffectsKey } from "./internal-session-key.js";
import { validateDeliveryCanonicalSessionEntry } from "./session-accessor.sqlite-entry-read.js";
import { parseSessionEntryJson, selectSessionEntryRows } from "./session-accessor.sqlite-status.js";
import { assertCanonicalSqliteSessionKeysCurrent } from "./session-canonical-key.js";

const ROWS_PER_PAGE = 64;

export function readPromptCacheRecoveryKeys(
  database: OpenClawAgentReadOnlyDatabase,
  since: number,
): string[] {
  return withSqlitePostCommitPublications(sqlPublicationAnchor(database.db), () =>
    runSqliteReadSnapshotSync(database.db, () => {
      assertCanonicalSqliteSessionKeysCurrent(database);
      const query = selectSessionEntryRows(database, "list")
        .select(["current_session_id", "updated_at"])
        .orderBy("session_key")
        .limit(ROWS_PER_PAGE);
      const keys: string[] = [];
      let after: string | undefined;
      // PostgreSQL buffers each query response. A single snapshot keeps page boundaries stable
      // while both engines discard each page's full metadata after checking it.
      for (;;) {
        const page = executeSqliteQuerySync(
          database.db,
          after === undefined ? query : query.where("session_key", ">", after),
        ).rows;
        for (const row of page) {
          const entry = parseSessionEntryJson(row, "list");
          if (!entry || isInternalSessionEffectsKey(row.session_key)) {
            continue;
          }
          // An unrelated cold alias still invalidates a listing. Validate before filtering.
          validateDeliveryCanonicalSessionEntry(row.session_key, entry);
          if (isPromptCacheRecoveryCandidate(row.session_key, entry, since)) {
            keys.push(row.session_key);
          }
        }
        if (page.length < ROWS_PER_PAGE) {
          return keys;
        }
        after = page[page.length - 1]!.session_key;
      }
    }),
  );
}
