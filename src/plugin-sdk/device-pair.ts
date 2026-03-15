import { resolveGatewayPort as resolveCoreGatewayPort } from "../config/paths.js";
import type { OpenClawPluginApi } from "../plugins/types.js";

// Narrow plugin-sdk surface for the bundled device-pair plugin.
// Keep this list additive and scoped to symbols used under extensions/device-pair.

export { approveDevicePairing, listDevicePairing } from "../infra/device-pairing.js";
export { issueDeviceBootstrapToken } from "../infra/device-bootstrap.js";
export type { OpenClawPluginApi } from "../plugins/types.js";
export { resolveGatewayBindUrl } from "../shared/gateway-bind-url.js";
export { resolveTailnetHostWithRunner } from "../shared/tailscale-status.js";
export { runPluginCommandWithTimeout } from "./run-command.js";

export function resolveGatewayPort(
  cfg: OpenClawPluginApi["config"],
  env: NodeJS.ProcessEnv = process.env,
): number {
  return resolveCoreGatewayPort(cfg, env);
}
