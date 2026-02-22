import { loadConfig, resolveGatewayPort } from "../../config/config.js";
import { callGateway } from "../../gateway/call.js";
import { resolveLeastPrivilegeOperatorScopesForMethod } from "../../gateway/method-scopes.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../../utils/message-channel.js";
import { readStringParam } from "./common.js";

export const DEFAULT_GATEWAY_URL = "ws://127.0.0.1:18789";

export type GatewayCallOptions = {
  gatewayUrl?: string;
  gatewayToken?: string;
  timeoutMs?: number;
};

type GatewayOverrideTarget = "local" | "remote";

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

function trimToUndefined(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function pickFirstNonEmpty(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    if (value) {
      return value;
    }
  }
  return undefined;
}

function validateGatewayUrlOverrideForAgentTools(
  urlOverride: string,
  cfg: ReturnType<typeof loadConfig>,
): { origin: string; target: GatewayOverrideTarget } {
  const port = resolveGatewayPort(cfg);
  const allowed = new Map<string, GatewayOverrideTarget>([
    [`ws://127.0.0.1:${port}`, "local"],
    [`wss://127.0.0.1:${port}`, "local"],
    [`ws://localhost:${port}`, "local"],
    [`wss://localhost:${port}`, "local"],
    [`ws://[::1]:${port}`, "local"],
    [`wss://[::1]:${port}`, "local"],
  ]);

  const remoteUrl =
    typeof cfg.gateway?.remote?.url === "string" ? cfg.gateway.remote.url.trim() : "";
  if (remoteUrl) {
    try {
      const remote = canonicalizeToolGatewayWsUrl(remoteUrl);
      allowed.set(remote.key, "remote");
    } catch {
      // ignore: misconfigured remote url; tools should fall back to default resolution.
    }
  }

  const parsed = canonicalizeToolGatewayWsUrl(urlOverride);
  const target = allowed.get(parsed.key);
  if (!target) {
    throw new Error(
      [
        "gatewayUrl override rejected.",
        `Allowed: ws(s) loopback on port ${port} (127.0.0.1/localhost/[::1])`,
        "Or: configure gateway.remote.url and omit gatewayUrl to use the configured remote gateway.",
      ].join(" "),
    );
  }
  return { origin: parsed.origin, target };
}

function resolveGatewayTokenFallbackForOverride(params: {
  cfg: ReturnType<typeof loadConfig>;
  target: GatewayOverrideTarget;
}): string | undefined {
  const envToken = trimToUndefined(process.env.OPENCLAW_GATEWAY_TOKEN);
  const legacyEnvToken = trimToUndefined(process.env.CLAWDBOT_GATEWAY_TOKEN);
  const localConfigToken = trimToUndefined(params.cfg.gateway?.auth?.token);
  const remoteConfigToken = trimToUndefined(params.cfg.gateway?.remote?.token);
  if (params.target === "remote") {
    return pickFirstNonEmpty(remoteConfigToken);
  }
  return pickFirstNonEmpty(envToken, legacyEnvToken, localConfigToken);
}

export function resolveGatewayOptions(opts?: GatewayCallOptions) {
  // Prefer an explicit override; otherwise let callGateway choose based on config.
  const rawUrlOverride = trimToUndefined(opts?.gatewayUrl);
  let cfg: ReturnType<typeof loadConfig> | undefined;
  let resolvedUrl: { origin: string; target: GatewayOverrideTarget } | undefined;
  if (rawUrlOverride) {
    cfg = loadConfig();
    resolvedUrl = validateGatewayUrlOverrideForAgentTools(rawUrlOverride, cfg);
  }
  const explicitToken = trimToUndefined(opts?.gatewayToken);
  const token =
    explicitToken ??
    (resolvedUrl && cfg
      ? resolveGatewayTokenFallbackForOverride({ cfg, target: resolvedUrl.target })
      : undefined);
  const timeoutMs =
    typeof opts?.timeoutMs === "number" && Number.isFinite(opts.timeoutMs)
      ? Math.max(1, Math.floor(opts.timeoutMs))
      : 30_000;
  return { url: resolvedUrl?.origin, token, timeoutMs };
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
