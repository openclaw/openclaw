import { loadConfig, resolveGatewayPort } from "../../config/config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { buildGatewayConnectionDetails, callGateway } from "../../gateway/call.js";
import { resolveGatewayCredentialsFromConfig, trimToUndefined } from "../../gateway/credentials.js";
import {
  resolveLeastPrivilegeOperatorScopesForMethod,
  type OperatorScope,
} from "../../gateway/method-scopes.js";
import { isLoopbackHost } from "../../gateway/net.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../../gateway/protocol/client-info.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { normalizeLowercaseStringOrEmpty } from "../../shared/string-coerce.js";
import { readStringParam } from "./common.js";

export const DEFAULT_GATEWAY_URL = "ws://127.0.0.1:18789";

export type GatewayCallOptions = {
  gatewayUrl?: string;
  gatewayToken?: string;
  timeoutMs?: number;
};

type GatewayOverrideTarget = "local" | "remote";

function isRemoteAgentToolGatewayUrlSource(urlSource: string): boolean {
  return urlSource === "config gateway.remote.url" || urlSource === "env OPENCLAW_GATEWAY_URL";
}

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
    const message = formatErrorMessage(error);
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
  const key = `${url.protocol}//${normalizeLowercaseStringOrEmpty(url.host)}`;
  return { origin, key };
}

function readConfiguredRemoteGatewayKey(cfg: ReturnType<typeof loadConfig>): string | undefined {
  const remoteUrl =
    typeof cfg.gateway?.remote?.url === "string" ? cfg.gateway.remote.url.trim() : "";
  if (!remoteUrl) {
    return undefined;
  }
  try {
    return canonicalizeToolGatewayWsUrl(remoteUrl).key;
  } catch {
    // Ignore misconfigured remote URLs here and fall back to local-only matching.
    return undefined;
  }
}

function validateGatewayUrlOverrideForAgentTools(params: {
  cfg: OpenClawConfig;
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

  const remoteKey = readConfiguredRemoteGatewayKey(cfg);

  const parsed = canonicalizeToolGatewayWsUrl(params.urlOverride);
  if (remoteKey && parsed.key === remoteKey) {
    return { url: parsed.origin, target: "remote" };
  }
  if (localAllowed.has(parsed.key)) {
    return { url: parsed.origin, target: "local" };
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
  cfg: OpenClawConfig;
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

export function isRemoteGatewayTargetForAgentTools(params: {
  config?: ReturnType<typeof loadConfig>;
  gatewayUrl?: string;
}): boolean {
  // Always load config fresh when not explicitly provided. Using captured opts.config or {}
  // allows bypasses when gateway.mode or gateway.remote.url changes during a session.
  const cfg = params.config ?? loadConfig();
  const override = trimToUndefined(params.gatewayUrl);
  if (override) {
    const remoteKey = readConfiguredRemoteGatewayKey(cfg);
    if (remoteKey) {
      try {
        if (canonicalizeToolGatewayWsUrl(override).key === remoteKey) {
          return true;
        }
      } catch {
        // Let the actual gateway call reject invalid overrides; this helper is only for write guards.
      }
    }
    // In remote mode, loopback URLs may still be SSH or local-port tunnels into a remote gateway.
    // Treat those as remote so plugin config writes stay blocked when the target host is ambiguous.
    if (cfg.gateway?.mode === "remote") {
      return true;
    }
    try {
      return !isLoopbackHost(new URL(override).hostname);
    } catch {
      // Let the actual gateway call reject invalid overrides; treat malformed targets as remote
      // here so write guards stay conservative.
      return true;
    }
  }
  const connectionDetails = buildGatewayConnectionDetails({ config: cfg });
  // For mutation-guard purposes, treat OPENCLAW_GATEWAY_URL as remote. Even loopback URLs from
  // env may be SSH tunnels or port forwards into a remote gateway. The local-vs-remote distinction
  // for loopback env URLs only applies to read operations; writes to plugin/channel config must be
  // blocked when the target host is ambiguous.
  if (connectionDetails.urlSource === "env OPENCLAW_GATEWAY_URL") {
    return true;
  }
  return isRemoteAgentToolGatewayUrlSource(connectionDetails.urlSource);
}

export async function callGatewayTool<T = Record<string, unknown>>(
  method: string,
  opts: GatewayCallOptions,
  params?: unknown,
  extra?: { expectFinal?: boolean; scopes?: OperatorScope[] },
) {
  const gateway = resolveGatewayOptions(opts);
  const scopes = Array.isArray(extra?.scopes)
    ? extra.scopes
    : resolveLeastPrivilegeOperatorScopesForMethod(method);
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
