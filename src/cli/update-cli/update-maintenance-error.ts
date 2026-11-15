import { DoctorSqliteMaintenanceLockUnavailableError } from "../../commands/doctor-sqlite-maintenance-lock.js";
import { GatewayStateOwnerContentionError } from "../../infra/gateway-state-owner.js";
import { formatCliCommand } from "../command-format.js";

export function updateMaintenanceError(error: unknown): unknown {
  const message = `Stop the Gateway first (${formatCliCommand("openclaw gateway stop")}), then retry.`;
  return error instanceof GatewayStateOwnerContentionError ||
    error instanceof DoctorSqliteMaintenanceLockUnavailableError
    ? new Error(message, { cause: error })
    : error;
}
