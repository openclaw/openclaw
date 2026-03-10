import { loadConfig, resolveGatewayPort } from "../../config/config.js";
import { callGateway } from "../../gateway/call.js";
import { resolveGatewayCredentialsFromConfig, trimToUndefined } from "../../gateway/credentials.js";
import { resolveLeastPrivilegeOperatorScopesForMethod } from "../../gateway/method-scopes.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../../utils/message-channel.js";
import { readStringParam } from "./common.js";

export const DEFAULT_GATEWAY_URL = "ws://127.0.0.1:18789";

export type GatewayCallOptions = {
  gatewayUrl?: string;
  gatewayToken?: string;
  timeoutMs?: number;
};

export type GatewayOverrideTarget = "local" | "remote";

export function readGatewayCallOptions(params: Record<string, unknown>): GatewayCallOptions {
  return {
    gatewayUrl: readStringParam(params, "gatewayUrl", { trim: false }),
    gatewayToken: readStringParam(params, "gatewayToken", { trim: false }),
    timeoutMs: typeof params.timeoutMs === "number" ? params.timeoutMs : undefined,
  };
}

function canonicalizeToolGatewayWsUrl(raw: string): { origin: string; key: string } {
  const input = raw.trim();
  let url: URL;
  try {
    url = new URL(input);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`invalid gatewayUrl: ${input} (${message})`, { cause: error });
  }

  if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    throw new Error(`invalid gatewayUrl protocol: ${url.protocol} (expected ws:// or wss://)`);
  }
  if (url.username || url.password) {
    throw new Error("invalid gatewayUrl: credentials are not allowed");
  }
  if (url.search || url.hash) {
    throw new Error("invalid gatewayUrl: query/hash not allowed");
  }
  // Agents/tools expect the gateway websocket on the origin, not arbitrary paths.
  if (url.pathname && url.pathname !== "/") {
    throw new Error("invalid gatewayUrl: path not allowed");
  }

  const origin = url.origin;
  // Key: protocol + host only, lowercased. (host includes IPv6 brackets + port when present)
  const key = `${url.protocol}//${url.host.toLowerCase()}`;
  return { origin, key };
}

/**
 * Returns true when gateway.mode=remote is configured with a non-loopback remote URL.
 * This indicates the user is connecting to a remote gateway, possibly via SSH port forwarding
 * (ssh -N -L <local_port>:remote-host:<remote_port>). In that case, a loopback gatewayUrl
 * is a tunnel endpoint and should be classified as "remote" so deliveryContext is suppressed.
 */
function isNonLoopbackRemoteUrlConfigured(cfg: ReturnType<typeof loadConfig>): boolean {
  if (cfg.gateway?.mode !== "remote") {
    return false;
  }
  const remoteUrl =
    typeof cfg.gateway?.remote?.url === "string" ? cfg.gateway.remote.url.trim() : "";
  if (!remoteUrl) {
    return false;
  }
  try {
    const parsed = new URL(remoteUrl);
    const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    return !(host === "127.0.0.1" || host === "localhost" || host === "::1");
  } catch {
    return false;
  }
}

function isLoopbackHostname(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return h === "127.0.0.1" || h === "localhost" || h === "::1";
}

function validateGatewayUrlOverrideForAgentTools(params: {
  cfg: ReturnType<typeof loadConfig>;
  urlOverride: string;
}): { url: string; target: GatewayOverrideTarget } {
  const { cfg } = params;
  const port = resolveGatewayPort(cfg);
  const localAllowed = new Set<string>([
    `ws://127.0.0.1:${port}`,
    `wss://127.0.0.1:${port}`,
    `ws://localhost:${port}`,
    `wss://localhost:${port}`,
    `ws://[::1]:${port}`,
    `wss://[::1]:${port}`,
  ]);

  let remoteKey: string | undefined;
  const remoteUrl =
    typeof cfg.gateway?.remote?.url === "string" ? cfg.gateway.remote.url.trim() : "";
  if (remoteUrl) {
    try {
      const remote = canonicalizeToolGatewayWsUrl(remoteUrl);
      remoteKey = remote.key;
    } catch {
      // ignore: misconfigured remote url; tools should fall back to default resolution.
    }
  }

  const parsed = canonicalizeToolGatewayWsUrl(params.urlOverride);
  if (localAllowed.has(parsed.key)) {
    // A loopback URL on the configured port is normally the local gateway, but when
    // gateway.mode=remote is configured with a non-loopback remote URL, the user is
    // likely using SSH port forwarding (ssh -N -L ...) and this loopback is a tunnel
    // endpoint pointing to a remote gateway. Classify as "remote" so deliveryContext
    // is not forwarded to the remote server, which would misroute post-restart wake messages.
    const target = isNonLoopbackRemoteUrlConfigured(cfg) ? "remote" : "local";
    return { url: parsed.origin, target };
  }
  if (remoteKey && parsed.key === remoteKey) {
    return { url: parsed.origin, target: "remote" };
  }
  // Loopback URL on a non-configured port — could be either:
  //   (a) An SSH tunnel endpoint (ssh -N -L <port>:remote-host:<remote-port>) → "remote"
  //   (b) A local gateway running on a custom/non-default port → "local"
  // We can only distinguish (a) from (b) when a non-loopback remote URL is configured:
  // that proves gateway.mode=remote with an external host, so a loopback URL on any port
  // must be a forwarded tunnel. Without that evidence, treat the loopback as local so that
  // deliveryContext is not suppressed and heartbeat wake-up routing stays correct.
  const urlForTunnelCheck = new URL(params.urlOverride.trim()); // already validated above
  if (isLoopbackHostname(urlForTunnelCheck.hostname)) {
    const target = isNonLoopbackRemoteUrlConfigured(cfg) ? "remote" : "local";
    return { url: parsed.origin, target };
  }
  throw new Error(
    [
      "gatewayUrl override rejected.",
      `Allowed: ws(s) loopback on port ${port} (127.0.0.1/localhost/[::1])`,
      "Or: configure gateway.remote.url and omit gatewayUrl to use the configured remote gateway.",
    ].join(" "),
  );
}

function resolveGatewayOverrideToken(params: {
  cfg: ReturnType<typeof loadConfig>;
  target: GatewayOverrideTarget;
  explicitToken?: string;
}): string | undefined {
  if (params.explicitToken) {
    return params.explicitToken;
  }
  return resolveGatewayCredentialsFromConfig({
    cfg: params.cfg,
    env: process.env,
    modeOverride: params.target,
    remoteTokenFallback: params.target === "remote" ? "remote-only" : "remote-env-local",
    remotePasswordFallback: params.target === "remote" ? "remote-only" : "remote-env-local",
  }).token;
}

/**
 * Resolves whether a GatewayCallOptions points to a local or remote gateway.
 * Returns "remote" when a remote gatewayUrl override is present, OR when
 * gateway.mode=remote is configured with a gateway.remote.url set.
 * Returns "local" for explicit loopback URL overrides (127.0.0.1, localhost, [::1])
 * UNLESS gateway.mode=remote is configured with a non-loopback remote URL, which indicates
 * the loopback is an SSH tunnel endpoint — in that case returns "remote".
 * Returns undefined when no override is present and the effective target is the local gateway
 * (including the gateway.mode=remote + missing gateway.remote.url fallback-to-local case).
 *
 * This mirrors the URL resolution path used by callGateway/buildGatewayConnectionDetails so
 * that deliveryContext suppression decisions are based on the actual connection target, not just
 * the configured mode. Mismatches fixed vs the previous version:
 * 1. gateway.mode=remote without gateway.remote.url: callGateway falls back to local loopback;
 *    classifying that as "remote" would incorrectly suppress deliveryContext.
 * 2. Env URL overrides (OPENCLAW_GATEWAY_URL / CLAWDBOT_GATEWAY_URL) are picked up by
 *    callGateway but were ignored here, causing incorrect local/remote classification.
 * 3. Tunneled loopback URLs (ssh -N -L ...) when gateway.mode=remote with a non-loopback
 *    remote.url is configured: classifying as "local" would forward deliveryContext to the
 *    remote server, causing post-restart wake messages to be misrouted to the caller's chat.
 * 4. Loopback URLs on a non-local port (ssh -N -L <port>:...) with local mode or no remote
 *    URL configured: the non-local port cannot be the local gateway, so it must be a tunnel;
 *    classifying as "local" would forward deliveryContext to the remote server (misrouting).
 */
export function resolveGatewayTarget(opts?: GatewayCallOptions): GatewayOverrideTarget | undefined {
  const cfg = loadConfig();
  if (trimToUndefined(opts?.gatewayUrl) === undefined) {
    // No explicit gatewayUrl param — mirror callGateway's resolution path.
    // Check env URL overrides first (same precedence as buildGatewayConnectionDetails).
    const envUrlOverride =
      trimToUndefined(process.env.OPENCLAW_GATEWAY_URL) ??
      trimToUndefined(process.env.CLAWDBOT_GATEWAY_URL);
    if (envUrlOverride !== undefined) {
      try {
        return validateGatewayUrlOverrideForAgentTools({
          cfg,
          urlOverride: envUrlOverride,
        }).target;
      } catch {
        // URL rejected by the agent-tools allowlist (e.g. non-loopback URL not matching
        // gateway.remote.url, or URL with a non-root path like /ws). callGateway /
        // buildGatewayConnectionDetails will still use this env URL as-is, so we must
        // classify based on the actual target host — not silently fall back to local.
        try {
          const parsed = new URL(envUrlOverride.trim());
          // Normalize IPv6 brackets: "[::1]" → "::1"
          const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
          const isLoopback = host === "127.0.0.1" || host === "localhost" || host === "::1";
          if (isLoopback) {
            // Classify as "remote" only when a non-loopback remote URL is configured,
            // which proves the loopback is an SSH tunnel endpoint
            // (ssh -N -L <local_port>:remote-host:<remote_port>). Without that evidence
            // a loopback URL on any port — including a non-default port — could be a
            // local gateway on a custom port, so we preserve "local" classification to
            // keep deliveryContext intact and avoid heartbeat-stale routing regressions.
            if (isNonLoopbackRemoteUrlConfigured(cfg)) {
              return "remote";
            }
            return "local";
          }
          return "remote";
        } catch {
          // Truly malformed URL; callGateway will also fail. Fall through to config-based resolution.
        }
      }
    }
    // No env override. When mode=remote with a configured remote URL → truly remote.
    // When mode=remote but remote.url is absent, callGateway falls back to local loopback —
    // classify that as local (undefined) so deliveryContext is not suppressed.
    const remoteUrl =
      cfg.gateway?.mode === "remote" ? trimToUndefined(cfg.gateway?.remote?.url) : undefined;
    return cfg.gateway?.mode === "remote" && remoteUrl !== undefined ? "remote" : undefined;
  }
  return validateGatewayUrlOverrideForAgentTools({
    cfg,
    urlOverride: String(opts?.gatewayUrl),
  }).target;
}

export function resolveGatewayOptions(opts?: GatewayCallOptions) {
  const cfg = loadConfig();
  const validatedOverride =
    trimToUndefined(opts?.gatewayUrl) !== undefined
      ? validateGatewayUrlOverrideForAgentTools({
          cfg,
          urlOverride: String(opts?.gatewayUrl),
        })
      : undefined;
  const explicitToken = trimToUndefined(opts?.gatewayToken);
  const token = validatedOverride
    ? resolveGatewayOverrideToken({
        cfg,
        target: validatedOverride.target,
        explicitToken,
      })
    : explicitToken;
  const timeoutMs =
    typeof opts?.timeoutMs === "number" && Number.isFinite(opts.timeoutMs)
      ? Math.max(1, Math.floor(opts.timeoutMs))
      : 30_000;
  return { url: validatedOverride?.url, token, timeoutMs };
}

export async function callGatewayTool<T = Record<string, unknown>>(
  method: string,
  opts: GatewayCallOptions,
  params?: unknown,
  extra?: { expectFinal?: boolean },
) {
  const gateway = resolveGatewayOptions(opts);
  const scopes = resolveLeastPrivilegeOperatorScopesForMethod(method);
  return await callGateway<T>({
    url: gateway.url,
    token: gateway.token,
    method,
    params,
    timeoutMs: gateway.timeoutMs,
    expectFinal: extra?.expectFinal,
    clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
    clientDisplayName: "agent",
    mode: GATEWAY_CLIENT_MODES.BACKEND,
    scopes,
  });
}
