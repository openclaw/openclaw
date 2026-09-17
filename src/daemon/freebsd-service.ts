import { onExit } from "signal-exit";
import { discoverFreeBsdService } from "../../scripts/lib/freebsd-service-discovery.mjs";
import type { GatewayServiceEnvArgs } from "./service-types.js";

export async function readFreeBsdGatewayServiceDiscovery({ timeoutMs }: GatewayServiceEnvArgs) {
  return await discoverFreeBsdService({ timeoutMs, registerExitCleanup: onExit });
}

/** Only fresh native absence permits the existing foreground update path. */
export async function isFreeBsdGatewayServiceAbsent(args: GatewayServiceEnvArgs) {
  return (await readFreeBsdGatewayServiceDiscovery(args)).status === "absent";
}
