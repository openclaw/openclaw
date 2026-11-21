import { DoctorSqliteMaintenanceLockUnavailableError } from "../../commands/doctor-sqlite-maintenance-lock.js";
import { GatewayStateOwnerContentionError } from "../../infra/gateway-state-owner.js";
import { formatCliCommand } from "../command-format.js";

export function updateMaintenanceError(error: unknown): unknown {
  // Contention can precede handoff discovery; it does not establish a safe stop scope.
  const message = `Maintenance requires exclusive Gateway state access. An independent operator outside triage and the Gateway service must stop the Gateway first (${formatCliCommand("openclaw gateway stop")}), then retry. Do not stop it from this fixing subtree; preserve ownership refusals and later operator stops.`;
  return error instanceof GatewayStateOwnerContentionError ||
    error instanceof DoctorSqliteMaintenanceLockUnavailableError
    ? new Error(message, { cause: error })
    : error;
}
