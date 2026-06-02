import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveGatewayConnectionAuth } from "./connection-auth.js";
import { buildGatewayConnectionDetailsWithResolvers } from "./connection-details.js";
import type { ExplicitGatewayAuth } from "./credentials.js";

/** Normalize connection-detail provenance into the auth resolver's override source enum. */
export function resolveGatewayUrlOverrideSource(urlSource: string): "cli" | "env" | undefined {
  if (urlSource === "cli --url") {
    return "cli";
  }
  if (urlSource === "env OPENCLAW_GATEWAY_URL") {
    return "env";
  }
  return undefined;
}

export async function resolveGatewayClientBootstrap(params: {
  /** Config snapshot used for URL, timeout, and credential resolution. */
  config: OpenClawConfig;
  /** Optional URL supplied by the caller instead of config discovery. */
  gatewayUrl?: string;
  /** Explicit caller token/password overrides. */
  explicitAuth?: ExplicitGatewayAuth;
  /** Env snapshot used for URL/auth fallback resolution. */
  env?: NodeJS.ProcessEnv;
}): Promise<{
  /** Final Gateway URL selected for the client connection. */
  url: string;
  /** Human-readable source of the selected URL. */
  urlSource: string;
  /** Optional preauth timeout forwarded to the client watchdog. */
  preauthHandshakeTimeoutMs?: number;
  /** Token/password credentials resolved for the selected URL mode. */
  auth: {
    token?: string;
    password?: string;
  };
}> {
  const connection = buildGatewayConnectionDetailsWithResolvers({
    config: params.config,
    url: params.gatewayUrl,
  });
  const urlOverrideSource = resolveGatewayUrlOverrideSource(connection.urlSource);
  const auth = await resolveGatewayConnectionAuth({
    config: params.config,
    explicitAuth: params.explicitAuth,
    env: params.env ?? process.env,
    urlOverride: urlOverrideSource ? connection.url : undefined,
    urlOverrideSource,
  });
  return {
    url: connection.url,
    urlSource: connection.urlSource,
    preauthHandshakeTimeoutMs: params.config.gateway?.handshakeTimeoutMs,
    auth,
  };
}
