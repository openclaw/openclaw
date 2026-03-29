import { resolveGatewayPort } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.js";
import { readGatewayTokenEnv } from "../gateway/credentials.js";
import { resolveConfiguredSecretInputWithFallback } from "../gateway/resolve-configured-secret-input-string.js";
import { resolveControlUiLinks } from "./onboard-helpers.js";

export type ControlUiAccessUrlResult = {
  /** Base HTTP URL for the Control UI (no auth fragment). */
  httpUrl: string;
  /** Same as `httpUrl`, or with `#token=…` when token auth can be embedded safely. */
  dashboardUrl: string;
  tokenFragmentEmbedded: boolean;
  /** True when `gateway.auth.token` is SecretRef-backed (token is never embedded in URLs). */
  tokenSecretRefConfigured: boolean;
  /** Resolved gateway token when present (plain config, env, or resolved SecretRef). */
  authToken?: string;
  unresolvedRefReason?: string;
};

/**
 * Resolves the Control UI HTTP URL and, when allowed, the dashboard deep link with
 * `#token=…` (same rules as `openclaw dashboard`). SecretRef-managed tokens are
 * never embedded.
 */
export async function resolveControlUiAccessUrl(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): Promise<ControlUiAccessUrlResult> {
  const env = params.env ?? process.env;
  const port = resolveGatewayPort(params.cfg, env);
  const bind = params.cfg.gateway?.bind ?? "loopback";
  const basePath = params.cfg.gateway?.controlUi?.basePath;
  const customBindHost = params.cfg.gateway?.customBindHost;
  const links = resolveControlUiLinks({
    port,
    bind: bind === "lan" ? "loopback" : bind,
    customBindHost,
    basePath,
  });

  const resolved = await resolveConfiguredSecretInputWithFallback({
    config: params.cfg,
    env,
    value: params.cfg.gateway?.auth?.token,
    path: "gateway.auth.token",
    readFallback: () => readGatewayTokenEnv(env),
  });

  const token = resolved.value ?? "";
  const includeTokenInUrl = token.length > 0 && !resolved.secretRefConfigured;
  const dashboardUrl = includeTokenInUrl
    ? `${links.httpUrl}#token=${encodeURIComponent(token)}`
    : links.httpUrl;

  return {
    httpUrl: links.httpUrl,
    dashboardUrl,
    tokenFragmentEmbedded: includeTokenInUrl,
    tokenSecretRefConfigured: resolved.secretRefConfigured,
    ...(token.length > 0 ? { authToken: token } : {}),
    ...(resolved.unresolvedRefReason ? { unresolvedRefReason: resolved.unresolvedRefReason } : {}),
  };
}
