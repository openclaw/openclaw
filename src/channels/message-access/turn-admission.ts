import type { ChannelTurnAdmission } from "../turn/types.js";
import type { ChannelIngressDecision } from "./types.js";

/** Convert an ingress graph decision into turn admission. */
export function mapChannelIngressDecisionToTurnAdmission(
  decision: Pick<ChannelIngressDecision, "admission" | "reasonCode">,
): ChannelTurnAdmission {
  const reason = decision.reasonCode;
  if (decision.admission === "dispatch") {
    return { kind: "dispatch", reason };
  }
  if (decision.admission === "observe") {
    return { kind: "observeOnly", reason };
  }
  return decision.admission === "skip"
    ? { kind: "handled", reason }
    : { kind: "drop", reason, recordHistory: false };
}
