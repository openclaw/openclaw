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
  /** Runtime config snapshot containing local and remote Gateway auth settings. */
  config: OpenClawConfig;
  /** Env snapshot used for OPENCLAW_GATEWAY_* credential fallbacks. */
  env?: NodeJS.ProcessEnv;
  /** Explicit caller credentials that take precedence over config/env sources. */
  explicitAuth?: ExplicitGatewayAuth;
  /** Runtime URL override used to force remote/local credential selection. */
  urlOverride?: string;
  /** Identifies whether urlOverride came from CLI args or env. */
  urlOverrideSource?: "cli" | "env";
  /** Explicitly choose local or remote credential mode independent of config. */
  modeOverride?: GatewayCredentialMode;
  /** Source precedence for local token credentials. */
  localTokenPrecedence?: GatewayCredentialPrecedence;
  /** Source precedence for local password credentials. */
  localPasswordPrecedence?: GatewayCredentialPrecedence;
  /** Source precedence for remote token credentials. */
  remoteTokenPrecedence?: GatewayRemoteCredentialPrecedence;
  /** Source precedence for remote password credentials. */
  remotePasswordPrecedence?: GatewayRemoteCredentialPrecedence;
  /** Whether remote token lookup can fall back to local/env sources. */
  remoteTokenFallback?: GatewayRemoteCredentialFallback;
  /** Whether remote password lookup can fall back to local/env sources. */
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
 * Resolve connection credentials with SecretInput support for live clients.
 *
 * This async path is used when config values may point at secret providers that
 * need IO before a Gateway client can connect.
 */
export async function resolveGatewayConnectionAuth(
  params: GatewayConnectionAuthOptions,
): Promise<{ token?: string; password?: string }> {
  return await resolveGatewayCredentialsWithSecretInputs({
    config: params.config,
    ...toGatewayCredentialOptions({ ...params, cfg: params.config }),
  });
}

/** Resolve connection credentials from already-readable config/env values. */
export function resolveGatewayConnectionAuthFromConfig(
  params: Omit<GatewayConnectionAuthOptions, "config"> & { cfg: OpenClawConfig },
): { token?: string; password?: string } {
  return resolveGatewayCredentialsFromConfig(toGatewayCredentialOptions(params));
}
