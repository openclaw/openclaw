import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db-contract.js";
import { readSessionTranscriptActivePathEntryRelation } from "./session-accessor.sqlite-active-events.js";
import { validateSessionTranscriptContextInDatabase } from "./session-accessor.sqlite-model-context.js";
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
  return (
    !predicate.leafEntryId ||
    readSessionTranscriptActivePathEntryRelation(
      {
        agentId: database.agentId,
        storePath: database.path,
        sessionKey,
        sessionId: predicate.sessionId,
      },
      predicate.leafEntryId,
    ) !== "off-path"
  );
}
