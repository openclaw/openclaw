import { expressionBuilder } from "kysely";
import { jsonPathValue } from "../../infra/database-engine/json-values.js";
import type { DB } from "../../state/openclaw-agent-db.generated.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";

export type PendingInputAudience = { profileId: string; revokedOnly?: true };

/** Revoked prompts belong to their author, not the shared conversation. */
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
  return audience.revokedOnly
    ? eb.and([eb("state", "=", "cancelled"), eb("end_cause", "=", "revoked"), own])
    : eb.or([eb("end_cause", "is", null), eb("end_cause", "!=", "revoked"), own]);
}
