import type { ApplicationGatewaySnapshot } from "../app/context.ts";
import { hasOperatorAdminAccess } from "../app/operator-access.ts";
import { isGatewayMethodAdvertised } from "./gateway-methods.ts";

const terminalAccess = new WeakMap<
  NonNullable<ApplicationGatewaySnapshot["client"]>,
  { allowed: boolean; recoveryScope: string }
>();

/** Presentation survives transport loss; terminal actions still require a live connection. */
export function isTerminalAvailable(
  snapshot: ApplicationGatewaySnapshot,
  terminalEnabled: boolean,
): boolean {
  if (
    !snapshot.client ||
    !terminalEnabled ||
    snapshot.client.offlineRecoveryRetired ||
    snapshot.phase === "reload-required" ||
    snapshot.phase === "stopped"
  ) {
    if (snapshot.client) {
      terminalAccess.delete(snapshot.client);
    }
    return false;
  }
  if (snapshot.phase !== "connected") {
    const previous = terminalAccess.get(snapshot.client);
    return Boolean(
      previous && previous.recoveryScope === snapshot.client.recoveryScope && previous.allowed,
    );
  }
  const allowed =
    hasOperatorAdminAccess(snapshot.hello?.auth ?? null) &&
    (isGatewayMethodAdvertised(snapshot, "terminal.open") ?? false);
  terminalAccess.set(snapshot.client, { allowed, recoveryScope: snapshot.client.recoveryScope });
  return allowed;
}
