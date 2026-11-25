import type { GatewayLockRole } from "../../infra/gateway-lock-payload.js";
import {
  acquireGatewayStateOwnerFile,
  defaultPayload,
} from "../../infra/gateway-state-owner-record.js";
import { resolveGatewayStateOwnerPath } from "../../infra/gateway-state-owner.js";
import { getFileLockProcessStartTime } from "../../shared/pid-alive.js";

// A generic sidecar holds custody without registering schema authority in this process.
export function createUnregisteredStateOwner(
  databasePath: string,
  role: GatewayLockRole,
  pid = process.pid,
) {
  const ownerPath = resolveGatewayStateOwnerPath(databasePath);
  const payload = { ...defaultPayload(databasePath), pid, role };
  payload.startTime = getFileLockProcessStartTime(pid) ?? undefined;
  return acquireGatewayStateOwnerFile(databasePath, ownerPath, payload);
}
