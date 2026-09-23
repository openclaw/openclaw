import { isDeepStrictEqual } from "node:util";
import { executeSqliteQuerySync, sqliteStringSet } from "../../infra/kysely-sync.js";
import { runSqliteDeferredTransactionSync } from "../../infra/sqlite-transaction.js";
import { readOpenClawAgentDatabaseIdentity } from "../../state/openclaw-agent-db-identity.js";
import { withOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import type { PhysicalStore, SessionClaim } from "./legacy-main-session-migration.contract.js";
import { readExactSessionEntryRowForCanonicalRepair } from "./session-accessor.sqlite-canonical-repair.js";
import {
  readSqliteSessionGenerationClaim,
  readSqliteSessionGenerationWindows,
  rehomeSqliteSessionGenerationWindow,
} from "./session-accessor.sqlite-generation-copy.js";
import type { SqliteSessionGenerationClaim } from "./session-accessor.sqlite-generation.types.js";
import { readSessionNodeArtifactFingerprint } from "./session-accessor.sqlite-node-artifacts.js";
import { collectSessionStateIdsForEntry } from "./session-accessor.sqlite-references.js";
import { getSessionKysely } from "./session-accessor.sqlite-scope.js";
import { normalizeStoreSessionKey } from "./store-entry.js";
import type { SessionEntry } from "./types.js";

function projectEntryIdentity(entry: SessionEntry): SessionEntry {
  const projected: SessionEntry & {
    sessionFile?: unknown;
    transcriptPath?: unknown;
  } = { ...entry };
  delete projected.sessionFile;
  delete projected.transcriptPath;
  return projected;
}

function generationWindowIdentity(generation: SqliteSessionGenerationClaim, canonicalKey: string) {
  const {
    updated_at: _updatedAt,
    transcript_updated_at: _transcriptUpdatedAt,
    transcript_observed_at: _transcriptObservedAt,
    ...identity
  } = rehomeSqliteSessionGenerationWindow(
    generation.window,
    canonicalKey,
    new Set([normalizeStoreSessionKey(generation.window.session_key.trim())]),
  );
  return identity;
}

export function generationsMatch(
  left: SqliteSessionGenerationClaim,
  right: SqliteSessionGenerationClaim,
  canonicalKey: string,
): boolean {
  return (
    left.contentFingerprint === right.contentFingerprint &&
    isDeepStrictEqual(
      generationWindowIdentity(left, canonicalKey),
      generationWindowIdentity(right, canonicalKey),
    )
  );
}

export function claimsMatch(left: SessionClaim, right: SessionClaim): boolean {
  const generations = new Map(
    right.generations.map((generation) => [generation.window.session_id, generation]),
  );
  return (
    isDeepStrictEqual(projectEntryIdentity(left.entry), projectEntryIdentity(right.entry)) &&
    left.generations.every((generation) => {
      const other = generations.get(generation.window.session_id);
      return !other || generationsMatch(generation, other, left.canonicalKey);
    })
  );
}

export function claimUnchanged(current: SessionClaim, expected: SessionClaim): boolean {
  return (
    current.databaseIdentity === expected.databaseIdentity &&
    current.nodeArtifactFingerprint === expected.nodeArtifactFingerprint &&
    isDeepStrictEqual(projectEntryIdentity(current.entry), projectEntryIdentity(expected.entry)) &&
    current.generations.length === expected.generations.length &&
    current.generations.every(
      (generation, index) => generation.fingerprint === expected.generations[index]?.fingerprint,
    )
  );
}

export function claimFullyCopied(source: SessionClaim, destination: SessionClaim): boolean {
  const sessionIds = new Set(
    destination.generations.map((generation) => generation.window.session_id),
  );
  return (
    claimsMatch(source, destination) &&
    source.generations.every((generation) => sessionIds.has(generation.window.session_id))
  );
}

export function readClaim(
  database: Pick<OpenClawAgentDatabase, "agentId" | "db" | "path">,
  store: PhysicalStore,
  key: string,
  canonicalKey: string,
): SessionClaim | undefined {
  return runSqliteDeferredTransactionSync(database.db, () => {
    const row = readExactSessionEntryRowForCanonicalRepair(database, key);
    if (!row) {
      return undefined;
    }
    const windows = readSqliteSessionGenerationWindows(
      database,
      [key],
      collectSessionStateIdsForEntry(row.entry),
    );
    return {
      canonicalKey,
      databaseIdentity: readOpenClawAgentDatabaseIdentity(database).identity,
      entry: row.entry,
      generations: windows.map((window) => readSqliteSessionGenerationClaim(database, window)),
      key,
      nodeArtifactFingerprint: readSessionNodeArtifactFingerprint(database, key),
      store,
    };
  });
}

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
