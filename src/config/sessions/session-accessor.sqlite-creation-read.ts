import { withSqlitePostCommitPublications } from "../../infra/sqlite-post-commit.js";
import { runSqliteDeferredTransactionSync } from "../../infra/sqlite-transaction.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { readSelectedSessionEntriesInDatabase } from "./session-accessor.sqlite-entry-list.read.js";
import { projectSqliteSessionParticipantsBatch } from "./session-accessor.sqlite-participant-projection.js";
import type { SessionEntryCreateWithTranscriptContext } from "./session-accessor.types.js";
import {
  collectSessionEntryLookupKeys,
  normalizeStoreSessionKey,
  resolveSessionEntryCandidates,
} from "./store-entry.js";

export type SessionCreationSnapshot = SessionEntryCreateWithTranscriptContext & {
  normalizedKey: string;
  legacyKeys: string[];
};

/** Target payload and the indexed label claim share one snapshot on the executing owner. */
export function readSessionCreationSnapshotInDatabase(
  database: Pick<OpenClawAgentDatabase, "agentId" | "db" | "path">,
  sessionKey: string,
  label?: string,
): SessionCreationSnapshot {
  return withSqlitePostCommitPublications(database.db, () =>
    runSqliteDeferredTransactionSync(database.db, () => {
      const normalizedKey = normalizeStoreSessionKey(sessionKey);
      const keys = [normalizedKey, ...collectSessionEntryLookupKeys(database, sessionKey)];
      const candidates = readSelectedSessionEntriesInDatabase(database, keys, {
        fullEntryKeys: keys,
        label,
      });
      const entries = projectSqliteSessionParticipantsBatch(
        database.db,
        new Map(
          candidates
            .filter((candidate) => keys.includes(candidate.sessionKey))
            .map(({ sessionKey: key, entry }) => [key, entry]),
        ),
      );
      const resolved = resolveSessionEntryCandidates({
        entries: Array.from(entries, ([key, entry]) => ({ sessionKey: key, entry })),
        sessionKey,
        canonicalKeys: true,
      });
      const targetEntry = entries.get(normalizedKey);
      return {
        normalizedKey,
        legacyKeys: resolved.legacyKeys,
        existingEntry: resolved.existing ? { ...resolved.existing.entry } : undefined,
        targetEntry: targetEntry ? { ...targetEntry } : undefined,
        labelInUse:
          label !== undefined &&
          candidates.some(
            (candidate) =>
              candidate.sessionKey !== normalizedKey && candidate.entry.label === label,
          ),
      };
    }),
  );
}
