import { acquireFileLockSync } from "../../infra/file-lock-manager.js";
import { parseGatewayLockPayload, type GatewayLockRole } from "../../infra/gateway-lock-payload.js";
import { defaultPayload } from "../../infra/gateway-state-owner-record.js";
import { acquireGatewayStateOwner } from "../../infra/gateway-state-owner.js";

// A generic sidecar holds custody without registering schema authority in this process.
export function createUnregisteredStateOwner(
  databasePath: string,
  role: GatewayLockRole,
  pid = process.pid,
) {
  const anchor = acquireGatewayStateOwner({ databasePath });
  anchor.release();
  return acquireFileLockSync(anchor.path, {
    lockPath: anchor.path,
    retry: { retries: 0 },
    payload: () => ({ ...defaultPayload(databasePath), pid, role, startTime: undefined }),
    parsePayload: parseGatewayLockPayload,
  });
}
