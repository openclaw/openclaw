import type {
  GatewayAuthConfig,
  GatewayTailscaleMode,
  GatewayTrustedProxyConfig,
} from "../config/types.gateway.js";
import { resolveSecretInputRef } from "../config/types.secrets.js";
import { resolveGatewayCredentialsFromValues } from "./credentials.js";

/** Authentication modes after config, override, and credential inputs are combined. */
export type ResolvedGatewayAuthMode = "none" | "token" | "password" | "trusted-proxy";

/** Records which input selected the effective Gateway auth mode. */
export type ResolvedGatewayAuthModeSource =
  | "override"
  | "config"
  | "password"
  | "token"
  | "default";

/** Fully resolved Gateway auth policy before startup validates required secrets. */
export type ResolvedGatewayAuth = {
  /** Effective Gateway auth mode after overrides, config, and credential inference. */
  mode: ResolvedGatewayAuthMode;
  /** Input source that selected `mode`, useful for diagnostics. */
  modeSource?: ResolvedGatewayAuthModeSource;
  /** Effective bearer token when token auth is active or available. */
  token?: string;
  /** Effective password when password auth is active or available. */
  password?: string;
  /** Whether Tailscale Serve may satisfy the network auth boundary. */
  allowTailscale: boolean;
  /** Trusted proxy policy when proxy-auth mode is configured. */
  trustedProxy?: GatewayTrustedProxyConfig;
};

/** Shared-secret auth shape exposed to Gateway clients that support a single bearer secret. */
export type EffectiveSharedGatewayAuth = {
  /** Shared-secret mode clients should use. */
  mode: "token" | "password";
  /** Shared secret value, if already resolved. */
  secret: string | undefined;
};

/** Resolve Gateway auth mode, credentials, trusted-proxy policy, and Tailscale allowance. */
export function resolveGatewayAuth(params: {
  /** Persisted Gateway auth config. */
  authConfig?: GatewayAuthConfig | null;
  /** Sparse runtime override layered over persisted config. */
  authOverride?: GatewayAuthConfig | null;
  /** Env snapshot used for fallback token/password resolution. */
  env?: NodeJS.ProcessEnv;
  /** Tailscale exposure mode used to infer allowTailscale defaults. */
  tailscaleMode?: GatewayTailscaleMode;
}): ResolvedGatewayAuth {
  const baseAuthConfig = params.authConfig ?? {};
  const authOverride = params.authOverride ?? undefined;
  const authConfig: GatewayAuthConfig = { ...baseAuthConfig };
  if (authOverride) {
    // Runtime overrides are sparse field overlays; omitted fields keep the
    // persisted config so callers can replace one auth knob without cloning all
    // credential and proxy settings.
    if (authOverride.mode !== undefined) {
      authConfig.mode = authOverride.mode;
    }
    if (authOverride.token !== undefined) {
      authConfig.token = authOverride.token;
    }
    if (authOverride.password !== undefined) {
      authConfig.password = authOverride.password;
    }
    if (authOverride.allowTailscale !== undefined) {
      authConfig.allowTailscale = authOverride.allowTailscale;
    }
    if (authOverride.rateLimit !== undefined) {
      authConfig.rateLimit = authOverride.rateLimit;
    }
    if (authOverride.trustedProxy !== undefined) {
      authConfig.trustedProxy = authOverride.trustedProxy;
    }
  }
  const env = params.env ?? process.env;
  const tokenRef = resolveSecretInputRef({ value: authConfig.token }).ref;
  const passwordRef = resolveSecretInputRef({ value: authConfig.password }).ref;
  // Secret refs are not plaintext credentials here. Startup/runtime secret
  // resolution validates active refs before request authorization sees them.
  const resolvedCredentials = resolveGatewayCredentialsFromValues({
    configToken: tokenRef ? undefined : authConfig.token,
    configPassword: passwordRef ? undefined : authConfig.password,
    env,
    tokenPrecedence: "config-first",
    passwordPrecedence: "config-first", // pragma: allowlist secret
  });
  const token = resolvedCredentials.token;
  const password = resolvedCredentials.password;
  const trustedProxy = authConfig.trustedProxy;

  let mode: ResolvedGatewayAuth["mode"];
  let modeSource: ResolvedGatewayAuth["modeSource"];
  if (authOverride?.mode !== undefined) {
    mode = authOverride.mode;
    modeSource = "override";
  } else if (authConfig.mode) {
    mode = authConfig.mode;
    modeSource = "config";
  } else if (password) {
    mode = "password";
    modeSource = "password";
  } else if (token) {
    mode = "token";
    modeSource = "token";
  } else {
    // Token remains the default so the config assertion can produce a clear
    // missing-token diagnostic instead of silently disabling Gateway auth.
    mode = "token";
    modeSource = "default";
  }

  const allowTailscale =
    // Tailscale serve can supply network-level access control, but password and
    // trusted-proxy modes keep their stricter explicit auth boundary.
    authConfig.allowTailscale ??
    (params.tailscaleMode === "serve" && mode !== "password" && mode !== "trusted-proxy");

  return {
    mode,
    modeSource,
    token,
    password,
    allowTailscale,
    trustedProxy,
  };
}

/** Return the effective token/password secret for clients that cannot model every auth mode. */
export function resolveEffectiveSharedGatewayAuth(params: {
  authConfig?: GatewayAuthConfig | null;
  authOverride?: GatewayAuthConfig | null;
  env?: NodeJS.ProcessEnv;
  tailscaleMode?: GatewayTailscaleMode;
}): EffectiveSharedGatewayAuth | null {
  const resolvedAuth = resolveGatewayAuth(params);
  if (resolvedAuth.mode === "token") {
    return {
      mode: "token",
      secret: resolvedAuth.token,
    };
  }
  if (resolvedAuth.mode === "password") {
    return {
      mode: "password",
      secret: resolvedAuth.password,
    };
  }
  return null;
}
