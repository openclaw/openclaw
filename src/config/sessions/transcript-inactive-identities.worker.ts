// Indexed point reads for inactive channel identities. The history worker owns
// execution; nothing here decodes message text or writes the channel cache.
import { executeSqliteQueryTakeFirstSync } from "../../infra/kysely-sync.js";
import { withCurrentProjectionSnapshot } from "./session-accessor.sqlite-active-projection.js";
import type { SessionTranscriptReadScope } from "./session-accessor.sqlite-contract.js";
import {
  getActiveTranscriptKysely,
  type CurrentTranscriptProjection,
} from "./session-accessor.sqlite-projection-read.js";
import type { SessionTranscriptInactiveIdentityProbe } from "./session-transcript-worker-read.types.js";

function readRecordedOffActivePath(
  projection: CurrentTranscriptProjection,
  match:
    | { column: "event_id"; value: string }
    | { column: "message_idempotency_key"; value: string },
): boolean {
  const db = getActiveTranscriptKysely(projection.database);
  const identity =
    match.column === "event_id"
      ? executeSqliteQueryTakeFirstSync(
          projection.database.db,
          db
            .selectFrom("transcript_event_identities as identity")
            .select("identity.seq")
            .where("identity.session_id", "=", projection.resolved.sessionId)
            .where("identity.event_id", "=", match.value)
            .limit(1),
        )
      : executeSqliteQueryTakeFirstSync(
          projection.database.db,
          db
            .selectFrom("transcript_event_identities as identity")
            .select("identity.seq")
            .where("identity.session_id", "=", projection.resolved.sessionId)
            .where("identity.message_idempotency_key", "=", match.value)
            .limit(1),
        );
  if (!identity) {
    return false;
  }
  const active = executeSqliteQueryTakeFirstSync(
    projection.database.db,
    db
      .selectFrom("session_transcript_active_events as active")
      .select("active.event_seq")
      .where("active.session_id", "=", projection.resolved.sessionId)
      .where("active.event_seq", "=", identity.seq)
      .limit(1),
  );
  return active === undefined;
}

/**
 * True only when the identity is recorded and off the active path.
 * An identity that cannot be found returns false so the caller keeps the row.
 * A cold or rebuilding projection throws and the caller abstains.
 */
export function readInactiveTranscriptIdentitySync(
  scope: SessionTranscriptReadScope,
  probe: SessionTranscriptInactiveIdentityProbe,
): boolean {
  return withCurrentProjectionSnapshot(scope, (projection) =>
    readRecordedOffActivePath(
      projection,
      probe.kind === "entry"
        ? { column: "event_id", value: probe.entryId }
        : { column: "message_idempotency_key", value: probe.sourceTurnId },
    ),
  );
}
