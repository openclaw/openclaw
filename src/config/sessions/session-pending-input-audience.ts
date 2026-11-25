import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { expressionBuilder } from "kysely";
import { jsonPathValue } from "../../infra/database-engine/json-values.js";
import type { DB } from "../../state/openclaw-agent-db.generated.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { parseSessionPendingInputMessage } from "./session-pending-input-value.js";
import type { SessionPendingInput } from "./session-pending-input.types.js";

export type PendingInputAudience = { profileId: string; revokedOnly?: true };

/** Marks an input cancelled by an access reduction, unlike a revoked operator credential. */
export function markParticipationRevokedMessageJson(messageJson: string): string {
  const message = parseSessionPendingInputMessage(messageJson);
  return JSON.stringify({
    ...message,
    __openclaw: { ...asOptionalRecord(message["__openclaw"]), participationRevoked: true },
  });
}

/** Participation-revoked prompts belong to their author, not the shared conversation. */
export function pendingInputAudienceEligibility(
  database: Pick<OpenClawAgentDatabase, "db">,
  audience: PendingInputAudience,
) {
  const eb = expressionBuilder<Pick<DB, "session_pending_inputs">, "session_pending_inputs">();
  const own = eb(
    jsonPathValue(
      database.db,
      eb.ref("message_json"),
      eb.val("$.__openclaw.requesterOrigin.operatorProfileId"),
    ),
    "=",
    audience.profileId,
  );
  const shared = eb(
    jsonPathValue(database.db, eb.ref("message_json"), eb.val("$.__openclaw.participationRevoked")),
    "is",
    null,
  );
  return audience.revokedOnly
    ? eb.and([eb("state", "=", "cancelled"), eb("end_cause", "=", "revoked"), own])
    : eb.or([eb("end_cause", "is", null), eb("end_cause", "!=", "revoked"), shared, own]);
}

/** Apply the audience rule to one projected input read by exact ID. */
export function isPendingInputVisibleToProfile(
  input: Pick<SessionPendingInput, "endCause" | "message">,
  profileId: string | undefined,
) {
  const metadata = asOptionalRecord(input.message["__openclaw"]);
  return (
    input.endCause !== "revoked" ||
    metadata?.participationRevoked !== true ||
    (Boolean(profileId) &&
      asOptionalRecord(metadata.requesterOrigin)?.operatorProfileId === profileId)
  );
}
