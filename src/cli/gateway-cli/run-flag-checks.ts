// Pure `gateway run` flag checks, shared by run.ts and the pre-bootstrap config guard.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { GatewayAuthMode, GatewayTailscaleMode } from "../../config/config.js";
import { parseTcpPort } from "../../infra/tcp-port.js";
import { formatInvalidPortOption } from "../error-format.js";
import { parseEnumOption, toOptionString } from "./run-option-values.js";
import type { GatewayRunOpts } from "./run-options.js";

export const GATEWAY_AUTH_MODES: readonly GatewayAuthMode[] = [
  "none",
  "token",
  "password",
  "trusted-proxy",
];
export const GATEWAY_TAILSCALE_MODES: readonly GatewayTailscaleMode[] = ["off", "serve", "funnel"];
export const GATEWAY_BIND_MODES = new Set<string>(["loopback", "lan", "auto", "custom", "tailnet"]);
export const INVALID_WS_LOG = 'Invalid --ws-log. Use "auto", "full", or "compact".';
export const INVALID_BIND =
  'Invalid --bind. Use "loopback", "lan", "tailnet", "auto", or "custom".';
export const INVALID_AUTH = 'Invalid --auth. Use "none", "token", "password", or "trusted-proxy".';
export const INVALID_TAILSCALE = 'Invalid --tailscale. Use "off", "serve", or "funnel".';

export type GatewayRunFlagOpts = Pick<
  GatewayRunOpts,
  "auth" | "bind" | "compact" | "port" | "tailscale" | "wsLog"
>;

/** Returns the first invalid-flag error, checking only CLI values (config is not loaded yet). */
export function findGatewayRunFlagError(opts: GatewayRunFlagOpts): string | undefined {
  const wsLog = opts.compact ? "compact" : toOptionString(opts.wsLog);
  if (wsLog !== undefined && wsLog !== "auto" && wsLog !== "compact" && wsLog !== "full") {
    return INVALID_WS_LOG;
  }
  if (opts.port !== undefined && parseTcpPort(opts.port) === null) {
    return formatInvalidPortOption("--port");
  }
  const bind = normalizeOptionalString(toOptionString(opts.bind));
  if (bind !== undefined && !GATEWAY_BIND_MODES.has(bind)) {
    return INVALID_BIND;
  }
  const auth = toOptionString(opts.auth);
  if (auth && !parseEnumOption(auth, GATEWAY_AUTH_MODES)) {
    return INVALID_AUTH;
  }
  const tailscale = toOptionString(opts.tailscale);
  return tailscale && !parseEnumOption(tailscale, GATEWAY_TAILSCALE_MODES)
    ? INVALID_TAILSCALE
    : undefined;
}
