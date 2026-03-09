/**
 * Lightweight plugin SDK entry point (`openclaw/plugin-sdk/core`).
 *
 * Exports only the minimal set of types and utilities needed by simple plugins
 * that don't require channel-specific APIs, webhook helpers, or media utilities.
 * Use `openclaw/plugin-sdk` for the full API surface.
 */

export type {
  AnyAgentTool,
  OpenClawPluginApi,
  OpenClawPluginService,
  ProviderAuthContext,
  ProviderAuthResult,
} from "../plugins/types.js";
export type { ChannelPlugin } from "../channels/plugins/types.plugin.js";
export type { PluginRuntime } from "../plugins/runtime/types.js";
export type { OpenClawConfig } from "../config/config.js";
export type { GatewayRequestHandlerOptions } from "../gateway/server-methods/types.js";

export { emptyPluginConfigSchema } from "../plugins/config-schema.js";
export { buildOauthProviderAuthResult } from "./provider-auth-result.js";

export {
  approveDevicePairing,
  listDevicePairing,
  rejectDevicePairing,
} from "../infra/device-pairing.js";

export {
  runPluginCommandWithTimeout,
  type PluginCommandRunOptions,
  type PluginCommandRunResult,
} from "./run-command.js";
export { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";

export { resolveGatewayBindUrl } from "../shared/gateway-bind-url.js";
export type { GatewayBindUrlResult } from "../shared/gateway-bind-url.js";

export { resolveTailnetHostWithRunner } from "../shared/tailscale-status.js";
export type {
  TailscaleStatusCommandResult,
  TailscaleStatusCommandRunner,
} from "../shared/tailscale-status.js";
