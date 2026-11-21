import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db-contract.js";
import { readCurrentProjectionSnapshot } from "./session-accessor.sqlite-projection-read.js";
import { readVisibleTranscriptStats } from "./session-accessor.sqlite-reset-window.js";
import { projectSessionActorContextMetadata } from "./session-actor-context-metadata.js";
import type { SessionActorStoredState } from "./session-actor-hydration.types.js";
import { projectSessionTranscriptFacts } from "./session-transcript-projection-facts.js";

/** Cold admission and changed context boundaries count once; ordinary appends carry deltas. */
export function initializeSessionActorContextStats(
  database: OpenClawAgentDatabase,
  state: SessionActorStoredState,
  previous?: SessionActorStoredState,
): void {
  if (
    state.transcript.contextStats ||
    !state.hot.entry ||
    state.transcript.coldArchive ||
    state.transcript.projection?.needsRebuild ||
    state.transcript.projection?.hasUnclassifiedEvents
  ) {
    return;
  }
  const version = state.hot.transcript.version;
  const prior = previous?.hot.transcript.version;
  if (
    previous?.transcript.contextStats &&
    previous.hot.entry?.sessionId === state.hot.entry.sessionId &&
    prior?.generation === version.generation &&
    prior.rawSeq === version.rawSeq &&
    prior.updatedAt === version.updatedAt
  ) {
    // Entry-only invalidation does not change totals for this freshly admitted transcript.
    state.transcript.contextStats = previous.transcript.contextStats;
    return;
  }
  if (state.hot.transcript.version.rawSeq === null) {
    state.transcript.contextStats = { eventCount: 0, sizeBytes: 0, boundaryActivePosition: -1 };
    return;
  }
  const metadata = projectSessionActorContextMetadata(state);
  if (metadata) {
    state.transcript.contextStats = {
      eventCount: metadata.eventCount,
      sizeBytes: metadata.sizeBytes,
      boundaryActivePosition: -1,
    };
    return;
  }
  try {
    const result = readCurrentProjectionSnapshot(
      database,
      {
        agentId: state.agentId,
        path: state.path,
        sessionKey: state.hot.target.sessionKey,
        sessionId: state.hot.entry.sessionId,
      },
      (projection) => readVisibleTranscriptStats(projection),
      state.transcript.complete ? projectSessionTranscriptFacts(state) : undefined,
    );
    if (result.kind === "value") {
      state.transcript.contextStats = result.value;
    }
  } catch {
    // Accounting is best effort; malformed context must not prevent unrelated actor operations.
  }
}
