import { GatewayServiceAuthorityError } from "../../daemon/service-update-authority.js";
import { DoctorMaintenanceRefusalError } from "../../infra/update-doctor-result.js";
import { GatewayRestartHealthError } from "./update-command-service-command.js";

export const VERIFIED_ACTIVATION_FAILURE_OUTCOMES = [
  "restart-health",
  "reported-failure",
  "authority",
  "unknown",
  "data-at-risk",
  "health-with-authority",
  "admission-unavailable",
] as const;

export async function simulateVerifiedActivationFailure(
  outcome: (typeof VERIFIED_ACTIVATION_FAILURE_OUTCOMES)[number],
  onVerified?: (verifiedAtMs: number) => void,
) {
  onVerified?.(Date.now());
  if (outcome === "data-at-risk") {
    throw new DoctorMaintenanceRefusalError("Incomplete migration", {
      kind: "data-at-risk",
      reason: "incomplete-migration",
    });
  }
  if (outcome === "reported-failure") {
    return "restart-health-failed" as const;
  }
  if (outcome === "authority") {
    throw new GatewayServiceAuthorityError(new Error("Service authority revoked"));
  }
  if (outcome === "admission-unavailable") {
    throw new DoctorMaintenanceRefusalError("Admission unavailable", {
      kind: "deferred",
      reason: "admission-unavailable",
    });
  }
  if (outcome === "health-with-authority") {
    throw new GatewayRestartHealthError("Health reporting failed", {
      cause: new GatewayServiceAuthorityError(new Error("Service authority revoked")),
    });
  }
  if (outcome === "unknown") {
    throw new Error("Unknown post-activation failure");
  }
  throw new GatewayRestartHealthError("post-activation receipt unavailable");
}
