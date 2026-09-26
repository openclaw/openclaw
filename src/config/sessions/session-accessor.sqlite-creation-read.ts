import { withSqlitePostCommitPublications } from "../../infra/sqlite-post-commit.js";
import { runSqliteDeferredTransactionSync } from "../../infra/sqlite-transaction.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { readSessionEntryCache } from "./session-accessor.sqlite-entry-cache.js";
import type { SessionEntryCacheSnapshot } from "./session-accessor.sqlite-entry-cache.types.js";
import { iterateSessionEntriesForListing } from "./session-accessor.sqlite-entry-list.read.js";
import type { SessionEntryCreateWithTranscriptContext } from "./session-accessor.types.js";
import {
  collectSessionEntryLookupKeys,
  normalizeStoreSessionKey,
  resolveSessionEntryCandidates,
} from "./store-entry.js";

type CreationFacts = {
  targetEntry: SessionEntryCreateWithTranscriptContext["targetEntry"];
  labels: Set<string | undefined>;
};

function* collectCreationCandidates(
  snapshot: SessionEntryCacheSnapshot,
  normalizedKey: string,
  facts: CreationFacts,
) {
  for (const candidate of iterateSessionEntriesForListing(snapshot)) {
    if (candidate.sessionKey === normalizedKey) {
      facts.targetEntry = candidate.entry;
    } else {
      facts.labels.add(candidate.entry.label);
    }
    yield candidate;
  }
}

export type SessionCreationSnapshot = Omit<
  SessionEntryCreateWithTranscriptContext,
  "isLabelInUse"
> & {
  normalizedKey: string;
  legacyKeys: string[];
  labels: Set<string | undefined>;
};

/** Target payload and sibling metadata come from one read transaction on the executing owner. */
export function readSessionCreationSnapshotInDatabase(
  database: Pick<OpenClawAgentDatabase, "agentId" | "db" | "path">,
  sessionKey: string,
): SessionCreationSnapshot {
  return withSqlitePostCommitPublications(database.db, () =>
    runSqliteDeferredTransactionSync(database.db, () => {
      // Listing validation rejects other structural aliases; these candidates retain
      // complete payloads in the same SELECT that captures sibling label metadata.
      const snapshot = readSessionEntryCache(database, {
        cache: false,
        projection: "list",
        fullEntryKeys: [
          normalizeStoreSessionKey(sessionKey),
          ...collectSessionEntryLookupKeys(database, sessionKey),
        ],
      });
      const facts: CreationFacts = { targetEntry: undefined, labels: new Set() };
      const resolved = resolveSessionEntryCandidates({
        entries: collectCreationCandidates(snapshot, normalizeStoreSessionKey(sessionKey), facts),
        sessionKey,
        canonicalKeys: true,
      });
      const { targetEntry, labels } = facts;
      return {
        normalizedKey: resolved.normalizedKey,
        legacyKeys: resolved.legacyKeys,
        existingEntry: resolved.existing ? { ...resolved.existing.entry } : undefined,
        targetEntry: targetEntry ? { ...targetEntry } : undefined,
        labels,
      };
    }),
  );
}
