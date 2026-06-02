import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveGatewayCredentialsWithSecretInputs } from "./credentials-secret-inputs.js";
import type {
  ExplicitGatewayAuth,
  GatewayCredentialMode,
  GatewayCredentialPrecedence,
  GatewayRemoteCredentialFallback,
  GatewayRemoteCredentialPrecedence,
} from "./credentials.js";
import { resolveGatewayCredentialsFromConfig } from "./credentials.js";

export type GatewayConnectionAuthOptions = {
  /** Runtime config snapshot used by Gateway clients and node-host startup. */
  config: OpenClawConfig;
  /** Optional env override for tests and callers that resolve auth from a prepared env map. */
  env?: NodeJS.ProcessEnv;
  /** CLI-provided credentials that must outrank config/env when present. */
  explicitAuth?: ExplicitGatewayAuth;
  /** Remote URL override used to force remote credential surfaces without mutating config. */
  urlOverride?: string;
  urlOverrideSource?: "cli" | "env";
  /** Credential mode override for call sites that know the connection target before config does. */
  modeOverride?: GatewayCredentialMode;
  /** Local token selection order for env/config/local fallback resolution. */
  localTokenPrecedence?: GatewayCredentialPrecedence;
  /** Local password selection order for env/config/local fallback resolution. */
  localPasswordPrecedence?: GatewayCredentialPrecedence;
  /** Remote token selection order for env/remote/local fallback resolution. */
  remoteTokenPrecedence?: GatewayRemoteCredentialPrecedence;
  /** Remote password selection order for env/remote/local fallback resolution. */
  remotePasswordPrecedence?: GatewayRemoteCredentialPrecedence;
  /** Remote token fallback policy after the preferred remote source is empty. */
  remoteTokenFallback?: GatewayRemoteCredentialFallback;
  /** Remote password fallback policy after the preferred remote source is empty. */
  remotePasswordFallback?: GatewayRemoteCredentialFallback;
};

function toGatewayCredentialOptions(
  params: Omit<GatewayConnectionAuthOptions, "config"> & { cfg: OpenClawConfig },
) {
  return {
    cfg: params.cfg,
    env: params.env,
    explicitAuth: params.explicitAuth,
    urlOverride: params.urlOverride,
    urlOverrideSource: params.urlOverrideSource,
    modeOverride: params.modeOverride,
    localTokenPrecedence: params.localTokenPrecedence,
    localPasswordPrecedence: params.localPasswordPrecedence,
    remoteTokenPrecedence: params.remoteTokenPrecedence,
    remotePasswordPrecedence: params.remotePasswordPrecedence,
    remoteTokenFallback: params.remoteTokenFallback,
    remotePasswordFallback: params.remotePasswordFallback,
  };
}

/**
 * Resolves the token/password pair used when a client or node host connects to
 * Gateway, including async SecretRef-backed credentials.
 */
export async function resolveGatewayConnectionAuth(
  params: GatewayConnectionAuthOptions,
): Promise<{ token?: string; password?: string }> {
  // Connection startup can reference SecretRef-backed credentials, so this path
  // must keep the async resolver even though most callers only read config/env.
  return await resolveGatewayCredentialsWithSecretInputs({
    config: params.config,
    ...toGatewayCredentialOptions({ ...params, cfg: params.config }),
  });
}

/**
 * Resolves connection credentials without SecretRef lookup for callers that
 * already operate on raw config/env values.
 */
export function resolveGatewayConnectionAuthFromConfig(
  params: Omit<GatewayConnectionAuthOptions, "config"> & { cfg: OpenClawConfig },
): { token?: string; password?: string } {
  return resolveGatewayCredentialsFromConfig(toGatewayCredentialOptions(params));
}
