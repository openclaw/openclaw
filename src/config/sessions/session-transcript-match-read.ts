import {
  createVisibleAssistantResultEventMatcher,
  matchesTranscriptEvent,
} from "../../sessions/transcript-visible-record.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import type { TranscriptEvent } from "./session-accessor.sqlite-contract.js";
import {
  readCurrentProjectionSnapshot,
  type CurrentTranscriptProjection,
} from "./session-accessor.sqlite-projection-read.js";
import {
  findTranscriptEventInDatabase,
  readTranscriptEventId,
} from "./session-accessor.sqlite-read.js";
import {
  readActiveTranscriptEntryAnchorFromProjection,
  readActiveTranscriptEntryAnchorInTransaction,
} from "./session-accessor.sqlite-transcript-anchor.js";
import { SessionTranscriptProjectionUnavailableError } from "./session-transcript-projection-error.js";
import type { SessionTranscriptEventMatchRequest } from "./session-transcript-worker-read.types.js";

/** Select one record inside the caller's existing SQLite snapshot. */
export function findTranscriptEventMatchingInDatabase(
  database: Pick<OpenClawAgentDatabase, "db" | "path">,
  request: SessionTranscriptEventMatchRequest,
): { event: TranscriptEvent } | undefined {
  const { target, match } = request;
  const matchesVisibleFinal =
    match.kind === "visible-final"
      ? createVisibleAssistantResultEventMatcher(match.runId)
      : undefined;
  const read = (projection?: CurrentTranscriptProjection) => {
    const matches = (event: TranscriptEvent) => {
      const entryId = readTranscriptEventId(event);
      return (
        (matchesVisibleFinal ? matchesVisibleFinal(event) : matchesTranscriptEvent(event, match)) &&
        ((match.kind !== "active-assistant" && match.kind !== "canvas-widget") ||
          Boolean(
            entryId &&
            target.sessionKey &&
            (projection
              ? readActiveTranscriptEntryAnchorFromProjection(projection, entryId)
              : readActiveTranscriptEntryAnchorInTransaction({
                  database,
                  resolved: { ...target, sessionKey: target.sessionKey },
                  entryId,
                })),
          ))
      );
    };
    return findTranscriptEventInDatabase(
      database,
      target.sessionId,
      matches,
      match.kind === "latest"
        ? undefined
        : (event) => matchesTranscriptEvent(event, match, "navigation"),
    );
  };
  if (match.kind !== "canvas-widget") {
    return read();
  }
  const snapshot = readCurrentProjectionSnapshot(
    { ...database, agentId: target.databaseAgentId ?? target.agentId },
    target,
    read,
  );
  if (snapshot.kind === "unavailable") {
    throw new SessionTranscriptProjectionUnavailableError(target.sessionId);
  }
  return snapshot.value;
}
