import {
  createUpdateFailureFact,
  type UpdateFailureFact,
} from "../../infra/update-failure-facts.js";
import {
  MANAGED_SERVICE_PREFLIGHT_DETAILS,
  type ManagedServicePreflightCode,
} from "../../infra/update-preflight-details.js";

/**
 * Facts for a managed-service-preflight refusal. Without them the error records the shared reason
 * as its only fact, so a public report cannot say which check refused.
 */
export function managedServiceRefusalFacts(
  code: ManagedServicePreflightCode,
  inspectionFacts: readonly UpdateFailureFact[] = [],
): UpdateFailureFact[] {
  return [
    createUpdateFailureFact({
      check: "managed-service-preflight",
      code,
      message: MANAGED_SERVICE_PREFLIGHT_DETAILS[code],
    }),
    ...inspectionFacts,
  ];
}
