import { createHmac } from "node:crypto";
import { loadConfig } from "../config/config.js";

const RELAY_TOKEN_CONTEXT = "openclaw-extension-relay-v1";
const DEFAULT_RELAY_PROBE_TIMEOUT_MS = 500;
const OPENCLAW_RELAY_BROWSER = "OpenClaw/extension-relay";

function resolveGatewayAuthToken(): string | null {
  const envToken =
    process.env.OPENCLAW_GATEWAY_TOKEN?.trim() || process.env.CLAWDBOT_GATEWAY_TOKEN?.trim();
  if (envToken) {
    return envToken;
  }
  try {
    const cfg = loadConfig();
    const configToken = cfg.gateway?.auth?.token?.trim();
    if (configToken) {
      return configToken;
    }
  } catch {
    // ignore config read failures; caller can fallback to per-process random token
  }
  return null;
}

function deriveRelayAuthToken(gatewayToken: string, port: number): string {
  return createHmac("sha256", gatewayToken).update(`${RELAY_TOKEN_CONTEXT}:${port}`).digest("hex");
}

export function resolveRelayAcceptedTokensForPort(port: number): string[] {
  const gatewayToken = resolveGatewayAuthToken();
  if (!gatewayToken) {
    throw new Error(
      "extension relay requires gateway auth token (set gateway.auth.token or OPENCLAW_GATEWAY_TOKEN)",
    );
  }
  const relayToken = deriveRelayAuthToken(gatewayToken, port);
  if (relayToken === gatewayToken) {
    return [relayToken];
  }
  return [relayToken, gatewayToken];
}

export function resolveRelayAuthTokenForPort(port: number): string {
  return resolveRelayAcceptedTokensForPort(port)[0];
}

export async function probeAuthenticatedOpenClawRelay(params: {
  baseUrl: string;
  relayAuthHeader: string;
  relayAuthToken: string;
  timeoutMs?: number;
}): Promise<boolean> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), params.timeoutMs ?? DEFAULT_RELAY_PROBE_TIMEOUT_MS);
  try {
    const versionUrl = new URL("/json/version", `${params.baseUrl}/`).toString();
    const res = await fetch(versionUrl, {
      signal: ctrl.signal,
      headers: { [params.relayAuthHeader]: params.relayAuthToken },
    });
    if (!res.ok) {
      return false;
    }
    const body = (await res.json()) as { Browser?: unknown };
    const browserName = typeof body?.Browser === "string" ? body.Browser.trim() : "";
    return browserName === OPENCLAW_RELAY_BROWSER;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
