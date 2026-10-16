import type { SessionActorStoredState } from "./session-actor-hydration.types.js";
import type { SessionTranscriptProjectionFacts } from "./session-transcript-projection-facts.types.js";

export function projectSessionTranscriptFacts(
  actor: SessionActorStoredState,
): SessionTranscriptProjectionFacts {
  const { active, coldArchive, identities, navigation, projection } = actor.transcript;
  let latestIndexedReset: SessionTranscriptProjectionFacts["latestIndexedReset"] = null;
  let hasUnindexedPrefix = true;
  for (const identity of identities.values()) {
    hasUnindexedPrefix &&= identity.seq !== navigation[0]?.seq;
    const row = active.get(identity.seq);
    if (
      identity.event_type === "reset" &&
      row &&
      (!latestIndexedReset || identity.seq > latestIndexedReset.seq)
    ) {
      latestIndexedReset = {
        active_position: row.active_position,
        event_type: "reset",
        seq: identity.seq,
      };
    }
  }
  return {
    cold: Boolean(coldArchive),
    generation: actor.hot.transcript.version.generation ?? undefined,
    updatedAt: actor.hot.transcript.version.updatedAt,
    hasUnclassified: projection?.hasUnclassifiedEvents ?? false,
    latestIndexedReset,
    hasUnindexedPrefix,
    latestSeq: navigation.at(-1)?.seq ?? null,
    state: projection && {
      activeEventCount: projection.activeEventCount,
      activeMessageCount: projection.activeMessageCount,
      indexedSeq: projection.indexedSeq,
      leafEventId: projection.leafEventId,
      needsRebuild: projection.needsRebuild,
    },
  };
}
