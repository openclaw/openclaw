import { isDeepStrictEqual } from "node:util";
import { runSqliteReadSnapshotSync } from "../../infra/sqlite-transaction.js";
import { readOpenClawAgentDatabaseIdentity } from "../../state/openclaw-agent-db-identity.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import type {
  PhysicalStore,
  SessionClaim,
  SessionComparisonClaim,
} from "./legacy-main-session-migration.contract.js";
import { readExactSessionEntryRowForCanonicalRepair } from "./session-accessor.sqlite-canonical-repair.js";
import {
  readSqliteSessionGenerationClaim,
  readSqliteSessionGenerationComparison,
  readSqliteSessionGenerationWindows,
  rehomeSqliteSessionGenerationWindow,
} from "./session-accessor.sqlite-generation-copy.js";
import type { SqliteSessionGenerationComparison } from "./session-accessor.sqlite-generation.types.js";
import { readSessionNodeArtifactFingerprint } from "./session-accessor.sqlite-node-artifacts.js";
import { collectSessionStateIdsForEntry } from "./session-accessor.sqlite-references.js";
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

function generationWindowIdentity(
  generation: SqliteSessionGenerationComparison,
  canonicalKey: string,
) {
  // Derived previews and local write clocks do not distinguish retained histories.
  const {
    updated_at: _updatedAt,
    transcript_updated_at: _transcriptUpdatedAt,
    transcript_observed_at: _transcriptObservedAt,
    row_transcript_json: _rowTranscript,
    row_transcript_updated_at: _rowTranscriptUpdatedAt,
    ...identity
  } = rehomeSqliteSessionGenerationWindow(
    generation.window,
    canonicalKey,
    new Set([normalizeStoreSessionKey(generation.window.session_key.trim())]),
  );
  return identity;
}

export function generationsMatch(
  left: SqliteSessionGenerationComparison,
  right: SqliteSessionGenerationComparison,
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

export function claimsMatch(left: SessionComparisonClaim, right: SessionComparisonClaim): boolean {
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
  return runSqliteReadSnapshotSync(database.db, () => {
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

/** Detection compares history; only Doctor acquires the artifact custody needed to delete it. */
export function readComparisonClaim(
  database: Pick<OpenClawAgentDatabase, "agentId" | "db" | "path">,
  store: PhysicalStore,
  key: string,
  canonicalKey: string,
): SessionComparisonClaim | undefined {
  return runSqliteReadSnapshotSync(database.db, () => {
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
      entry: row.entry,
      generations: windows.map((window) => readSqliteSessionGenerationComparison(database, window)),
      key,
      store,
    };
  });
}
