import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import {
  readSessionEntryCache,
  type SessionEntryCacheSnapshot,
} from "./session-accessor.sqlite-entry-cache.js";
import { iterateSessionEntriesForListing } from "./session-accessor.sqlite-entry.js";
import { resolveSqliteScope, toDatabaseOptions } from "./session-accessor.sqlite-scope.js";
import type {
  SessionAccessScope,
  SessionEntryCreateWithTranscriptContext,
} from "./session-accessor.types.js";
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

/** Owns the complete target payload and sibling-label facts before asynchronous preparation. */
export function readSessionCreationSnapshot(
  scope: SessionAccessScope,
): SessionEntryCreateWithTranscriptContext & {
  normalizedKey: string;
  legacyKeys: string[];
} {
  const database = openOpenClawAgentDatabase(toDatabaseOptions(resolveSqliteScope(scope)));
  // Listing validation rejects other structural aliases; these candidates retain
  // complete payloads in the same SELECT that captures sibling label metadata.
  const snapshot = readSessionEntryCache(database, {
    cache: false,
    projection: "list",
    fullEntryKeys: [
      normalizeStoreSessionKey(scope.sessionKey),
      ...collectSessionEntryLookupKeys(database, scope.sessionKey),
    ],
  });
  const facts: CreationFacts = { targetEntry: undefined, labels: new Set() };
  const resolved = resolveSessionEntryCandidates({
    entries: collectCreationCandidates(snapshot, normalizeStoreSessionKey(scope.sessionKey), facts),
    sessionKey: scope.sessionKey,
    canonicalKeys: true,
  });
  const { targetEntry, labels } = facts;
  return {
    normalizedKey: resolved.normalizedKey,
    legacyKeys: resolved.legacyKeys,
    existingEntry: resolved.existing ? { ...resolved.existing.entry } : undefined,
    targetEntry: targetEntry ? { ...targetEntry } : undefined,
    isLabelInUse: (label) => labels.has(label),
  };
}
