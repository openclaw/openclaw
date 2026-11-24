import type { OpenClawDatabaseMaintenanceScope } from "../state/openclaw-state-db-async-lifecycle.js";
import { releaseOpenClawStateDatabaseCustody } from "../state/openclaw-state-db-cache.js";
import type { GatewayLockRole } from "./gateway-lock-payload.js";
import type { GatewayOwnerLease } from "./gateway-owner-lease.js";

/** Keep physical custody until the final lease write and native consumers settle. */
export async function drainGatewayLockResources(
  lease: GatewayOwnerLease | undefined,
  maintenance: Pick<OpenClawDatabaseMaintenanceScope, "close"> | undefined,
  role: GatewayLockRole,
): Promise<void> {
  await lease?.release();
  await maintenance?.close();
  if (role === "gateway") {
    await releaseOpenClawStateDatabaseCustody();
  }
}
