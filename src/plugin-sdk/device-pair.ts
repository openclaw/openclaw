/**
 * Device pairing plugin SDK exports
 *
 * This module provides device pairing functionality for OpenClaw plugins.
 */

export type { OpenClawPluginApi } from "./core.js";

export {
  approveDevicePairing,
  listDevicePairing,
  rejectDevicePairing,
} from "../infra/device-pairing.js";

export { issueDeviceBootstrapToken } from "../infra/device-bootstrap.js";

export { resolveGatewayBindUrl } from "../shared/gateway-bind-url.js";

export { resolveTailnetHostWithRunner } from "../shared/tailscale-status.js";

export { runPluginCommandWithTimeout } from "./run-command.js";
