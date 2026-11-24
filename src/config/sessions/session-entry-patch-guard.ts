import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db-contract.js";
import { readCurrentProjectionSnapshot } from "./session-accessor.sqlite-projection-read.js";
import { isOnActivePathInProjection } from "./session-accessor.sqlite-transcript-anchor.js";
import { readSessionTranscriptWatermarkInDatabase } from "./session-accessor.sqlite-transcript-watermark.js";
import type {
  SessionEntryPatchCommitted,
  SessionEntryPatchGuard,
} from "./session-entry-patch.types.js";

export function readSessionEntryPatchPredicate(
  database: OpenClawAgentDatabase,
  sessionKey: string,
  predicate: SessionEntryPatchGuard["shouldCommitIf"],
  committedTranscript?: SessionEntryPatchCommitted["transcriptPredicate"],
): { matches: boolean; transcriptPredicate?: SessionEntryPatchCommitted["transcriptPredicate"] } {
  if (!predicate) {
    return { matches: true };
  }
  const watermark =
    committedTranscript?.sessionId === predicate.sessionId
      ? committedTranscript.watermark
      : readSessionTranscriptWatermarkInDatabase(database, predicate.sessionId);
  if (watermark.generation !== predicate.generation) {
    return { matches: false };
  }
  const transcriptPredicate = { sessionId: predicate.sessionId, watermark };
  const leafEntryId = predicate.leafEntryId;
  if (!leafEntryId) {
    return { matches: true, transcriptPredicate };
  }
  const projection = readCurrentProjectionSnapshot(
    database,
    { agentId: database.agentId, path: database.path, sessionKey, sessionId: predicate.sessionId },
    (snapshot) => isOnActivePathInProjection(snapshot, leafEntryId),
  );
  // A stale predicate retries through its host reader, which owns projection repair.
  return {
    matches: projection.kind === "value" && projection.value,
    transcriptPredicate,
  };
}
