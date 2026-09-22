/** Admission verdict for explicit Doctor maintenance before mutable repair. */
import { formatCliCommand } from "../cli/command-format.js";
import type { PreManagedServiceStop } from "../cli/update-cli/update-command-service-maintenance.js";
import { hasGatewayServiceStopUnsafeError } from "../daemon/service-inspection-error.js";
import { collectNestedErrorCandidates } from "../infra/error-graph-internal.js";
import { StateDatabaseCoordinatorContentionError } from "../infra/state-database-coordinator-errors.js";
import { DoctorStateMigrationRefusalError } from "../infra/state-migrations.messages.js";
import { DoctorUnreadableStateDatabaseError } from "../infra/state-repair-message.js";
import type { DoctorMaintenanceRefusal } from "../infra/update-doctor-result.js";

/** Admission has not opened repair writers; deferral cannot authorize any later work. */
export function classifyDoctorMaintenanceRefusal(error: unknown): DoctorMaintenanceRefusal {
  const causes = collectNestedErrorCandidates(error);
  if (hasGatewayServiceStopUnsafeError(error)) {
    return { kind: "data-at-risk", reason: "active-mutation" };
  }
  if (causes.some((cause) => cause instanceof DoctorUnreadableStateDatabaseError)) {
    return { kind: "data-at-risk", reason: "unreadable-state" };
  }
  if (causes.some((cause) => cause instanceof DoctorStateMigrationRefusalError)) {
    return { kind: "data-at-risk", reason: "incomplete-migration" };
  }
  return {
    kind: "deferred",
    reason: causes.some((cause) => cause instanceof StateDatabaseCoordinatorContentionError)
      ? "coordinator-contention"
      : "admission-unavailable",
  };
}

export function assertDoctorMaintenanceInspection(
  inspection: PreManagedServiceStop,
  env: NodeJS.ProcessEnv,
): void {
  const kind = inspection.serviceUpdateVerdict?.kind;
  // Unavailable inspection grants no service authority. The state coordinators
  // and agent leases below still exclude live writers before repair.
  if (
    !inspection.blockMessage &&
    (kind === "unavailable" ||
      (inspection.inspected &&
        (kind === "owned" || kind === "absent" || inspection.offline === true)))
  ) {
    return;
  }
  throw new Error(
    inspection.blockMessage ??
      `Gateway service ownership or shutdown could not be verified. Run ${formatCliCommand("openclaw gateway status --deep", env)} and stop it through its service owner before retrying.`,
  );
}
