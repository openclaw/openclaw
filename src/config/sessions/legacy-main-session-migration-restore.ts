import { executeSqliteQuerySync, sqliteStringSet } from "../../infra/kysely-sync.js";
import { withOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import { readClaim } from "./legacy-main-session-migration-claims.js";
import type { SessionClaim } from "./legacy-main-session-migration.contract.js";
import { getSessionKysely } from "./session-accessor.sqlite-scope.js";

export async function restoreColdSessionClaims(
  claims: SessionClaim[],
  env: NodeJS.ProcessEnv,
  beforePersistentApply?: () => void,
): Promise<void> {
  for (const [index, claim] of claims.entries()) {
    const cold = withOpenClawAgentDatabaseReadOnly(
      (database) =>
        executeSqliteQuerySync(
          database.db,
          getSessionKysely(database.db)
            .selectFrom("session_transcript_cold_archives")
            .select("session_id")
            .where(
              "session_id",
              "in",
              sqliteStringSet(claim.generations.map((generation) => generation.window.session_id)),
            ),
        ).rows,
      { agentId: claim.store.databaseAgentId, env, path: claim.store.path },
    );
    if (!cold.found) {
      throw new Error(`Legacy session store changed before history restoration: ${claim.key}`);
    }
    if (
      cold.value.length === 0 &&
      claim.generations.every((generation) => !generation.coldArchive)
    ) {
      continue;
    }
    const { restoreSessionColdTranscript } = await import("./session-cold-storage.js");
    for (const generation of cold.value) {
      await restoreSessionColdTranscript(
        {
          agentId: claim.store.databaseAgentId,
          env,
          sessionId: generation.session_id,
          storePath: claim.store.path,
        },
        beforePersistentApply,
      );
    }
    const refreshed = withOpenClawAgentDatabaseReadOnly(
      (database) => readClaim(database, claim.store, claim.key, claim.canonicalKey),
      { agentId: claim.store.databaseAgentId, env, path: claim.store.path },
    );
    if (!refreshed.found || !refreshed.value) {
      throw new Error(`Legacy session changed during history restoration: ${claim.key}`);
    }
    claims[index] = refreshed.value;
  }
}
