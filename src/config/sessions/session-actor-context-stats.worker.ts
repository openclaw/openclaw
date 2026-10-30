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
      // A metadata-only rewrite can change retained-prefix bytes without rotating generation.
      (projection) => readVisibleTranscriptStats(projection, true),
      state.transcript.complete ? projectSessionTranscriptFacts(state) : undefined,
    );
    if (result.kind === "value") {
      state.transcript.contextStats = result.value;
    }
  } catch {
    // Accounting is best effort; malformed context must not prevent unrelated actor operations.
  }
}
