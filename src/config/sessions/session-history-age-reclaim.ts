// Entitlement for GitHub Unlock: the age-driven transcript archive pass keeps
// the session-history-eviction module under the line-cap ratchet by placing the
// post-archive page reclamation here.
import { retrofitSqliteAutoVacuumAndReclaim } from "../../infra/sqlite-wal-reclamation.js";
import type { SqliteSessionArchivePruningDiagnostics } from "./session-accessor.sqlite-contract.js";
import { withSqliteSessionPageReclamation } from "./session-accessor.sqlite-page-reclamation.js";
import type { OpenClawAgentDatabaseOptions } from "../../state/openclaw-agent-db.js";
import {
  runExclusiveSqliteSessionWrite,
  withSqliteSessionDatabase,
} from "./session-accessor.sqlite-scope.js";
import type { SessionHistoryCheckpointGate } from "./session-history-budget-state.js";
import { reclaimSqliteFreePages } from "./session-history-archive-pruning.js";

/**
 * Reclaim freelist pages freed by an age-driven archive pass. Best-effort: a
 * busy or locked file skips cleanly and the next pass retries; committed
 * archives are never rolled back. Legacy stores that never received the doctor
 * `auto_vacuum=INCREMENTAL` retrofit keep every deleted page in the freelist —
 * incremental vacuum is a no-op for them — so flip the header and VACUUM once
 * before incremental reclamation.
 */
export async function reclaimAgeDrivenArchivePages(
  databaseOptions: OpenClawAgentDatabaseOptions,
  checkpointGate: SessionHistoryCheckpointGate,
): Promise<void> {
  try {
    await withSqliteSessionPageReclamation(
      databaseOptions,
      async (reclaimPages, assertCurrent, preparedOptions) => {
        await runExclusiveSqliteSessionWrite(
          preparedOptions,
          async () =>
            withSqliteSessionDatabase(preparedOptions, (database) => {
              retrofitSqliteAutoVacuumAndReclaim(database.db);
            }),
          "session.history.age-retention-reclaim",
        );
        const pageDiagnostics: SqliteSessionArchivePruningDiagnostics = {
          trigger: "after-eviction",
        };
        checkpointGate.afterNs = process.hrtime.bigint();
        return await reclaimSqliteFreePages(preparedOptions, pageDiagnostics, {
          reclaimPages,
          checkpointGate,
          assertCurrent,
        });
      },
    );
  } catch {
    // Best-effort reclamation only; committed archives are never rolled back.
  }
}