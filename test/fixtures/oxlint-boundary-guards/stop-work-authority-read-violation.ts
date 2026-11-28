import { decideOperatorAdmission } from "../../../src/gateway/operator-admission.js";
import { resolveOperatorRolePolicyForProfile } from "../../../src/gateway/operator-role-policy.js";

// A stop that asks whether the person may still run turns into a mid-run re-check.
export function stopWorkStartedBy(profileId: string) {
  return [decideOperatorAdmission, resolveOperatorRolePolicyForProfile(profileId, {})];
}
