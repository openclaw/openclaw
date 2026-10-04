import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db-contract.js";
import { readSessionTranscriptActivePathEntryRelation } from "./session-accessor.sqlite-active-events.js";
import { readSessionTranscriptWatermarkInDatabase } from "./session-accessor.sqlite-transcript-watermark.js";
import type { SessionEntryPatchGuard } from "./session-entry-patch.types.js";

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
