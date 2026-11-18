// Closed reset intervals locate the (previous reset, this reset] window around an older event.
import { executeSqliteQueryTakeFirstSync } from "../../infra/kysely-sync.js";
import {
  getActiveTranscriptKysely,
  type CurrentTranscriptProjection,
} from "./session-accessor.sqlite-projection-read.js";
import { readUnindexedHistoryControls } from "./session-accessor.sqlite-reset-window.js";

export type ClosedResetInterval = {
  startExclusiveActivePosition: number;
  endInclusiveActivePosition: number;
};

function selectActiveResetRows(projection: CurrentTranscriptProjection) {
  return getActiveTranscriptKysely(projection.database)
    .selectFrom("session_transcript_active_events as active")
    .innerJoin("transcript_event_identities as identity", (join) =>
      join
        .onRef("identity.session_id", "=", "active.session_id")
        .onRef("identity.seq", "=", "active.event_seq"),
    )
    .select("active.active_position")
    .where("active.session_id", "=", projection.resolved.sessionId)
    .where("identity.event_type", "=", "reset");
}

/** Closed interval (previous reset, this reset] for an active-path event outside the latest window. */
export function resolveClosedResetInterval(
  projection: CurrentTranscriptProjection,
  target: { activePosition: number; eventType: string },
): ClosedResetInterval | undefined {
  let closing =
    target.eventType === "reset"
      ? { active_position: target.activePosition }
      : executeSqliteQueryTakeFirstSync(
          projection.database.db,
          selectActiveResetRows(projection)
            .where("active.active_position", ">", target.activePosition)
            .orderBy("active.active_position", "asc")
            .limit(1),
        );
  const unindexedResets = readUnindexedHistoryControls(projection).filter(
    (row) => row.event.type === "reset",
  );
  if (target.eventType !== "reset") {
    const unindexedClosing = unindexedResets.find(
      (row) => row.active_position > target.activePosition,
    );
    if (
      unindexedClosing &&
      (!closing || unindexedClosing.active_position < closing.active_position)
    ) {
      closing = unindexedClosing;
    }
  }
  if (!closing) {
    return undefined;
  }
  let opening = executeSqliteQueryTakeFirstSync(
    projection.database.db,
    selectActiveResetRows(projection)
      .where("active.active_position", "<", closing.active_position)
      .orderBy("active.active_position", "desc")
      .limit(1),
  );
  const unindexedOpening = unindexedResets.findLast(
    (row) => row.active_position < closing.active_position,
  );
  if (
    unindexedOpening &&
    (!opening || unindexedOpening.active_position > opening.active_position)
  ) {
    opening = unindexedOpening;
  }
  return {
    startExclusiveActivePosition: opening?.active_position ?? -1,
    endInclusiveActivePosition: closing.active_position,
  };
}
