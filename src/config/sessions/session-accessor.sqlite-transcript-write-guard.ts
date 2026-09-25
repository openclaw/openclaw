import { redactIdentifier } from "@openclaw/normalization-core/node-crypto";
import { sql } from "kysely";
import { executeSqliteQueryTakeFirstSync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../../state/openclaw-agent-db.generated.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import type {
  SessionTranscriptWriteScope,
  TranscriptAppendRefusal,
} from "./session-accessor.sqlite-contract.js";
import { readSessionEntryRow } from "./session-accessor.sqlite-entry-store.js";
import type { ResolvedTranscriptScope } from "./session-accessor.sqlite-scope.js";
import { assertSessionTranscriptHot } from "./session-cold-storage-state.js";
import {
  assertOwnedTranscriptWriteCommit,
  SessionTranscriptWriterClaimReboundError,
} from "./transcript-write-context.js";
import type { InternalSessionEntry } from "./types.js";

/** Revision guards keep this JSON predicate off stable mutation paths. */
export function createSessionTranscriptOwnerPredicate(
  database: Pick<OpenClawAgentDatabase, "db">,
  expected: Pick<InternalSessionEntry, "sessionId" | "lifecycleRevision" | "activeWriterRunId"> & {
    sessionKey: string;
  },
): () => boolean {
  let query = getNodeSqliteKysely<Pick<OpenClawAgentKyselyDatabase, "session_nodes">>(database.db)
    .selectFrom("session_nodes")
    .select((eb) => eb.val(1).as("matches"))
    .where("session_key", "=", expected.sessionKey)
    .where("current_session_id", "=", expected.sessionId)
    .where((eb) => eb(eb.fn("json_valid", ["entry_json"]), "=", 1))
    // JSON.parse uses the last duplicate key; SQLite extraction uses the first.
    .where(/* kysely-allow-raw: JSON1 table iteration rejects ambiguous private owner fields. */ sql<boolean>`NOT EXISTS (
        SELECT 1 FROM json_each(entry_json)
        WHERE key IN ('sessionId', 'lifecycleRevision', 'activeWriterRunId')
        GROUP BY key HAVING count(*) > 1
      )`);
  for (const [jsonPath, value] of [
    ["$.sessionId", expected.sessionId],
    ["$.lifecycleRevision", expected.lifecycleRevision],
    ["$.activeWriterRunId", expected.activeWriterRunId],
  ] as const) {
    query = query.where((eb) =>
      value === undefined
        ? eb(eb.fn("json_type", ["entry_json", eb.val(jsonPath)]), "is", null)
        : eb.and([
            eb(eb.fn("json_type", ["entry_json", eb.val(jsonPath)]), "=", "text"),
            eb(eb.fn("json_extract", ["entry_json", eb.val(jsonPath)]), "=", value),
          ]),
    );
  }
  return () => executeSqliteQueryTakeFirstSync(database.db, query)?.matches === 1;
}

export function resolveTranscriptAppendRefusal(
  entry: InternalSessionEntry | undefined,
  resolved: ResolvedTranscriptScope,
  scope: SessionTranscriptWriteScope,
): TranscriptAppendRefusal | undefined {
  if (
    entry &&
    entry.sessionId === resolved.sessionId &&
    (scope.expectedLifecycleRevision === undefined ||
      entry.lifecycleRevision === scope.expectedLifecycleRevision) &&
    (scope.expectedWriterRunId === undefined ||
      entry.activeWriterRunId === scope.expectedWriterRunId)
  ) {
    return undefined;
  }
  const identity = {
    agentIdHash: redactIdentifier(resolved.agentId),
    expectedSessionIdHash: redactIdentifier(resolved.sessionId),
    sessionKeyHash: redactIdentifier(resolved.sessionKey),
  };
  if (!entry) {
    return { ...identity, code: "session-entry-missing" };
  }
  return {
    ...identity,
    actualSessionIdHash: redactIdentifier(entry.sessionId),
    code: "session-rebound",
  };
}

export function assertLockedTranscriptWriteAllowed(
  database: OpenClawAgentDatabase,
  resolved: ResolvedTranscriptScope,
  scope: SessionTranscriptWriteScope,
): InternalSessionEntry | undefined {
  assertSessionTranscriptHot(database.db, resolved.sessionId);
  const fencedScope = {
    ...scope,
    sessionId: resolved.sessionId,
    sessionKey: resolved.sessionKey,
  };
  assertOwnedTranscriptWriteCommit(fencedScope);
  if (
    fencedScope.expectedLifecycleRevision === undefined &&
    fencedScope.expectedWriterRunId === undefined
  ) {
    return undefined;
  }
  const fresh = readSessionEntryRow(database, resolved.sessionKey);
  const refusal = resolveTranscriptAppendRefusal(fresh?.entry, resolved, fencedScope);
  if (refusal) {
    throw new SessionTranscriptWriterClaimReboundError(refusal);
  }
  return fresh?.entry;
}
