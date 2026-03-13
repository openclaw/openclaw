import type { OpenClawConfig } from "../config/config.js";
import type { SecretDefaults } from "./runtime-shared.js";
import { coerceSecretRef, hasConfiguredSecretInput } from "../config/types.secrets.js";
import { isRecord } from "./shared.js";

const GATEWAY_TOKEN_ENV_KEYS = ["OPENCLAW_GATEWAY_TOKEN", "CLAWDBOT_GATEWAY_TOKEN"] as const;
const GATEWAY_PASSWORD_ENV_KEYS = [
  "OPENCLAW_GATEWAY_PASSWORD",
  "CLAWDBOT_GATEWAY_PASSWORD",
] as const;

export const GATEWAY_AUTH_SURFACE_PATHS = [
  "gateway.auth.token",
  "gateway.auth.password",
  "gateway.remote.token",
  "gateway.remote.password",
] as const;

export type GatewayAuthSurfacePath = (typeof GATEWAY_AUTH_SURFACE_PATHS)[number];

export type GatewayAuthSurfaceState = {
  path: GatewayAuthSurfacePath;
  active: boolean;
  reason: string;
  hasSecretRef: boolean;
};

export type GatewayAuthSurfaceStateMap = Record<GatewayAuthSurfacePath, GatewayAuthSurfaceState>;

function readNonEmptyEnv(env: NodeJS.ProcessEnv, names: readonly string[]): string | undefined {
  for (const name of names) {
    const raw = env[name];
    if (typeof raw !== "string") {
      continue;
    }
    const trimmed = raw.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  }
  return undefined;
}

function formatAuthMode(mode: string | undefined): string {
  return mode ?? "unset";
}

function describeRemoteConfiguredSurface(parts: {
  remoteMode: boolean;
  remoteUrlConfigured: boolean;
  tailscaleRemoteExposure: boolean;
}): string {
  const reasons: string[] = [];
  if (parts.remoteMode) {
    reasons.push('gateway.mode is "remote"');
  }
  if (parts.remoteUrlConfigured) {
    reasons.push("gateway.remote.url is configured");
  }
  if (parts.tailscaleRemoteExposure) {
    reasons.push('gateway.tailscale.mode is "serve" or "funnel"');
  }
  return reasons.join("; ");
}

function createState(params: {
  path: GatewayAuthSurfacePath;
  active: boolean;
  reason: string;
  hasSecretRef: boolean;
}): GatewayAuthSurfaceState {
  return {
    path: params.path,
    active: params.active,
    reason: params.reason,
    hasSecretRef: params.hasSecretRef,
  };
}

export function evaluateGatewayAuthSurfaceStates(params: {
  config: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  defaults?: SecretDefaults;
}): GatewayAuthSurfaceStateMap {
  const defaults = params.defaults ?? params.config.secrets?.defaults;
  const gateway = params.config.gateway as Record<string, unknown> | undefined;
  if (!isRecord(gateway)) {
    return {
      "gateway.auth.token": createState({
        path: "gateway.auth.token",
        active: false,
        reason: "gateway configuration is not set.",
        hasSecretRef: false,
      }),
      "gateway.auth.password": createState({
        path: "gateway.auth.password",
        active: false,
        reason: "gateway configuration is not set.",
        hasSecretRef: false,
      }),
      "gateway.remote.token": createState({
        path: "gateway.remote.token",
        active: false,
        reason: "gateway configuration is not set.",
        hasSecretRef: false,
      }),
      "gateway.remote.password": createState({
        path: "gateway.remote.password",
        active: false,
        reason: "gateway configuration is not set.",
        hasSecretRef: false,
      }),
    };
  }
  const auth = isRecord(gateway?.auth) ? gateway.auth : undefined;
  const remote = isRecord(gateway?.remote) ? gateway.remote : undefined;
  const authMode = auth && typeof auth.mode === "string" ? auth.mode : undefined;

  const hasAuthTokenRef = coerceSecretRef(auth?.token, defaults) !== null;
  const hasAuthPasswordRef = coerceSecretRef(auth?.password, defaults) !== null;
  const hasRemoteTokenRef = coerceSecretRef(remote?.token, defaults) !== null;
  const hasRemotePasswordRef = coerceSecretRef(remote?.password, defaults) !== null;

  const envToken = readNonEmptyEnv(params.env, GATEWAY_TOKEN_ENV_KEYS);
  const envPassword = readNonEmptyEnv(params.env, GATEWAY_PASSWORD_ENV_KEYS);
  const localTokenConfigured = hasConfiguredSecretInput(auth?.token, defaults);
  const localPasswordConfigured = hasConfiguredSecretInput(auth?.password, defaults);
  const remoteTokenConfigured = hasConfiguredSecretInput(remote?.token, defaults);
  const passwordSourceConfigured = Boolean(envPassword || localPasswordConfigured);

  const localTokenCanWin =
    authMode !== "password" && authMode !== "none" && authMode !== "trusted-proxy";
  const localTokenSurfaceActive =
    localTokenCanWin &&
    !envToken &&
    (authMode === "token" || (authMode === undefined && !passwordSourceConfigured));
  const tokenCanWin = Boolean(envToken || localTokenConfigured || remoteTokenConfigured);
  const passwordCanWin =
    authMode === "password" ||
    (authMode !== "token" && authMode !== "none" && authMode !== "trusted-proxy" && !tokenCanWin);

  const remoteMode = gateway?.mode === "remote";
  const remoteUrlConfigured = typeof remote?.url === "string" && remote.url.trim().length > 0;
  const tailscale =
    isRecord(gateway?.tailscale) && typeof gateway.tailscale.mode === "string"
      ? gateway.tailscale
      : undefined;
  const tailscaleRemoteExposure = tailscale?.mode === "serve" || tailscale?.mode === "funnel";
  const remoteEnabled = remote?.enabled !== false;
  const remoteConfiguredSurface = remoteMode || remoteUrlConfigured || tailscaleRemoteExposure;
  const remoteTokenFallbackActive = localTokenCanWin && !envToken && !localTokenConfigured;
  const remoteTokenActive = remoteEnabled && (remoteConfiguredSurface || remoteTokenFallbackActive);
  const remotePasswordFallbackActive = !envPassword && !localPasswordConfigured && passwordCanWin;
  const remotePasswordActive =
    remoteEnabled && (remoteConfiguredSurface || remotePasswordFallbackActive);

  const authPasswordReason = (() => {
    if (!auth) {
      return "gateway.auth is not configured.";
    }
    if (passwordCanWin) {
      return authMode === "password"
        ? 'gateway.auth.mode is "password".'
        : "no token source can win, so password auth can win.";
    }
    if (authMode === "token" || authMode === "none" || authMode === "trusted-proxy") {
      return `gateway.auth.mode is "${authMode}".`;
    }
    if (envToken) {
      return "gateway token env var is configured.";
    }
    if (localTokenConfigured) {
      return "gateway.auth.token is configured.";
    }
    if (remoteTokenConfigured) {
      return "gateway.remote.token is configured.";
    }
    return "token auth can win.";
  })();

  const authTokenReason = (() => {
    if (!auth) {
      return "gateway.auth is not configured.";
    }
    if (authMode === "token") {
      return envToken ? "gateway token env var is configured." : 'gateway.auth.mode is "token".';
    }
    if (authMode === "password" || authMode === "none" || authMode === "trusted-proxy") {
      return `gateway.auth.mode is "${authMode}".`;
    }
    if (envToken) {
      return "gateway token env var is configured.";
    }
    if (envPassword) {
      return "gateway password env var is configured.";
    }
    if (localPasswordConfigured) {
      return "gateway.auth.password is configured.";
    }
    return "token auth can win (mode is unset and no password source is configured).";
  })();

  const remoteSurfaceReason = describeRemoteConfiguredSurface({
    remoteMode,
    remoteUrlConfigured,
    tailscaleRemoteExposure,
  });

  const remoteTokenReason = (() => {
    if (!remote) {
      return "gateway.remote is not configured.";
    }
    if (!remoteEnabled) {
      return "gateway.remote.enabled is false.";
    }
    if (remoteConfiguredSurface) {
      return `remote surface is active: ${remoteSurfaceReason}.`;
    }
    if (remoteTokenFallbackActive) {
      return "local token auth can win and no env/auth token is configured.";
    }
    if (!localTokenCanWin) {
      return `token auth cannot win with gateway.auth.mode="${formatAuthMode(authMode)}".`;
    }
    if (envToken) {
      return "gateway token env var is configured.";
    }
    if (localTokenConfigured) {
      return "gateway.auth.token is configured.";
    }
    return "remote token fallback is not active.";
  })();

  const remotePasswordReason = (() => {
    if (!remote) {
      return "gateway.remote is not configured.";
    }
    if (!remoteEnabled) {
      return "gateway.remote.enabled is false.";
    }
    if (remoteConfiguredSurface) {
      return `remote surface is active: ${remoteSurfaceReason}.`;
    }
    if (remotePasswordFallbackActive) {
      return "password auth can win and no env/auth password is configured.";
    }
    if (!passwordCanWin) {
      if (authMode === "token" || authMode === "none" || authMode === "trusted-proxy") {
        return `password auth cannot win with gateway.auth.mode="${authMode}".`;
      }
      return "a token source can win, so password auth cannot win.";
    }
    if (envPassword) {
      return "gateway password env var is configured.";
    }
    if (localPasswordConfigured) {
      return "gateway.auth.password is configured.";
    }
    return "remote password fallback is not active.";
  })();

  return {
    "gateway.auth.token": createState({
      path: "gateway.auth.token",
      active: localTokenSurfaceActive,
      reason: authTokenReason,
      hasSecretRef: hasAuthTokenRef,
    }),
    "gateway.auth.password": createState({
      path: "gateway.auth.password",
      active: passwordCanWin,
      reason: authPasswordReason,
      hasSecretRef: hasAuthPasswordRef,
    }),
    "gateway.remote.token": createState({
      path: "gateway.remote.token",
      active: remoteTokenActive,
      reason: remoteTokenReason,
      hasSecretRef: hasRemoteTokenRef,
    }),
    "gateway.remote.password": createState({
      path: "gateway.remote.password",
      active: remotePasswordActive,
      reason: remotePasswordReason,
      hasSecretRef: hasRemotePasswordRef,
    }),
  };
}
