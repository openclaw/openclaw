// Gateway startup entry for the copy-and-swap state upgrade.
import { acquireGatewayLock } from "../infra/gateway-lock.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { upgradeStateDirectory } from "./state-upgrade.js";

const log = createSubsystemLogger("state/upgrade");

/**
 * Upgrade outdated state before any reader admits it, under exclusive state
 * ownership. Returns whether live files changed.
 */
export async function upgradeStateOnGatewayStart(env: NodeJS.ProcessEnv): Promise<boolean> {
  // File-only ownership: the old databases are not opened for writing.
  const lock = await acquireGatewayLock({ env, databaseAccess: "none", allowInTests: true });
  try {
    return (await upgradeStateDirectory({ env, log })).status !== "current";
  } finally {
    await lock?.release();
  }
}
