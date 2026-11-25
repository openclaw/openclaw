import { isDeepStrictEqual } from "node:util";
import { readOpenClawAgentDatabaseIdentity } from "../../state/openclaw-agent-db-identity.js";
import type { OpenClawAgentReadOnlyDatabase } from "../../state/openclaw-agent-db-readonly.js";
import { SessionMetadataUnavailableError } from "../../state/session-metadata-unavailable-error.js";
import { selectConversationRowsFromDatabase } from "./session-accessor.sqlite-conversation-read.js";
import { readExactSessionEntryRowValidated } from "./session-accessor.sqlite-entry-read.js";
import { readTranscriptContextVersionInTransaction } from "./session-accessor.sqlite-transcript-state.js";
import { createSessionEntryReadScope } from "./session-entry-cohort.worker.js";
import type { SessionEntryPatchCommit } from "./session-entry-patch.types.js";
import type {
  SessionExactEntriesWorkerInput,
  SessionExactEntriesWorkerResult,
} from "./session-entry-read.types.js";
import { listSessionMembersInDatabase } from "./session-sharing-store.kernel.js";
import type { SessionSourceValidation } from "./session-source-authority.js";
import type { InternalSessionEntry as SessionEntry } from "./types.js";

/** Currentness reads use the same admitted database and snapshot as entry reads. */
export function readSessionSourceChecks(
  request: SessionExactEntriesWorkerInput,
  capturedDatabase?: OpenClawAgentReadOnlyDatabase,
): SessionExactEntriesWorkerResult {
  const { readDatabase, snapshot } = createSessionEntryReadScope(capturedDatabase);
  const result = readDatabase(
    (database) =>
      snapshot(database, () => ({
        kind: "session-exact-entries" as const,
        entries: [],
        lifecycleTimestamps: {},
        sourceValidation: readSessionSourceValidation(database, request.sourceChecks),
      })),
    { ...request.database, env: request.env },
  );
  if (result.found) {
    return result.value;
  }
  if (result.reason !== "database-missing") {
    throw new SessionMetadataUnavailableError(result.reason);
  }
  return {
    kind: "session-exact-entries",
    entries: [],
    lifecycleTimestamps: {},
    sourceValidation: {
      conversationMatches: [],
      refusedSource: { index: 0, facts: { entry: undefined } },
    },
  };
}

export function readSessionSourceValidation(
  database: Parameters<typeof readExactSessionEntryRowValidated>[0],
  sources: SessionEntryPatchCommit["sources"],
  identity = readOpenClawAgentDatabaseIdentity(database).identity,
  entries?: ReadonlyMap<string, SessionEntry | undefined>,
): SessionSourceValidation {
  const validation: SessionSourceValidation = { conversationMatches: [] };
  for (const [index, source] of (sources ?? []).entries()) {
    if (identity !== source.source.databaseIdentity) {
      return { ...validation, refusedSource: { index, facts: { entry: undefined } } };
    }
    const entry = entries?.has(source.sessionKey)
      ? entries.get(source.sessionKey)
      : readExactSessionEntryRowValidated(database, source.sessionKey)?.entry;
    const members =
      source.members === undefined
        ? undefined
        : listSessionMembersInDatabase(database, source.sessionKey).map(
            (member) => member.identityId,
          );
    const alternatives = source.conversationAlternatives;
    let matching: number[] | undefined;
    if (alternatives) {
      const refs = [
        ...new Set(
          alternatives.flatMap((alternative) =>
            alternative.map(({ conversationRef }) => conversationRef),
          ),
        ),
      ];
      const rows = refs.length
        ? selectConversationRowsFromDatabase(database, {
            conversationRefs: refs,
            currentBindingOnly: true,
          })
        : [];
      const selected = new Map(
        rows.map((row) => [
          row.conversationRef,
          row.sessionKey && row.sessionId ? row.sessionKey : null,
        ]),
      );
      matching = alternatives.flatMap((alternative, alternativeIndex) =>
        alternative.every(
          (predicate) => (selected.get(predicate.conversationRef) ?? null) === predicate.sessionKey,
        )
          ? [alternativeIndex]
          : [],
      );
    }
    if (
      Boolean(entry) !== Boolean(source.expected) ||
      source.fields.some((field) => !isDeepStrictEqual(entry?.[field], source.expected?.[field])) ||
      matching?.length === 0 ||
      (members !== undefined && !isDeepStrictEqual(members, source.members)) ||
      (source.transcript &&
        !isDeepStrictEqual(
          { ...readTranscriptContextVersionInTransaction(database, source.transcript.sessionId) },
          source.transcript.version,
        ))
    ) {
      return { ...validation, refusedSource: { index, facts: { entry, members } } };
    }
    if (matching) {
      validation.conversationMatches.push({ index, alternatives: matching });
    }
  }
  return validation;
}
