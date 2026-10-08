import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db-contract.js";
import { readActivePathEntryRelationFromProjection } from "./session-accessor.sqlite-active-events.js";
import { validateSessionTranscriptContextInDatabase } from "./session-accessor.sqlite-model-context.js";
import { readCurrentProjectionSnapshot } from "./session-accessor.sqlite-projection-read.js";
import { readSessionTranscriptWatermarkInDatabase } from "./session-accessor.sqlite-transcript-watermark.js";
import type { SessionEntryPatchGuard } from "./session-entry-patch.types.js";

/** CLI planning yields; admission and the exact tip belong to the writer's transaction. */
export function assertSessionEntryPatchCliHistory(
  database: OpenClawAgentDatabase,
  sessionKey: string,
  context: SessionEntryPatchGuard["cliHistory"],
): void {
  if (!context) {
    return;
  }
  if (context.admission) {
    validateSessionTranscriptContextInDatabase(
      database,
      { agentId: database.agentId, path: database.path, sessionKey, sessionId: context.sessionId },
      { admission: context.admission },
    );
  }
  const fresh = readSessionTranscriptWatermarkInDatabase(database, context.sessionId);
  if (
    fresh.generation !== context.watermark.generation ||
    fresh.maxSeq !== context.watermark.maxSeq
  ) {
    throw new Error("CLI history changed before preparation");
  }
}

export function sessionEntryPatchPredicateMatches(
  database: OpenClawAgentDatabase,
  sessionKey: string,
  predicate: SessionEntryPatchGuard["shouldCommitIf"],
): boolean {
  if (!predicate) {
    return true;
  }
  if (
    readSessionTranscriptWatermarkInDatabase(database, predicate.sessionId).generation !==
    predicate.generation
  ) {
    return false;
  }
  const leafEntryId = predicate.leafEntryId;
  if (!leafEntryId) {
    return true;
  }
  const projection = readCurrentProjectionSnapshot(
    database,
    { agentId: database.agentId, path: database.path, sessionKey, sessionId: predicate.sessionId },
    (snapshot) => readActivePathEntryRelationFromProjection(snapshot, leafEntryId) !== "off-path",
  );
  // A stale predicate retries through its host reader, which owns projection repair.
  return projection.kind === "value" && projection.value;
}
