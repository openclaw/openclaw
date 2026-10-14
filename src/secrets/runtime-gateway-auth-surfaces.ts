/** Collects Gateway auth secret surfaces for secrets runtime preparation. */
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createGatewayCredentialPlan } from "../gateway/credential-planner.js";
import type { SecretDefaults } from "./runtime-shared.js";
import { isRecord } from "./shared.js";

/** Stable evaluation order for gateway credential surfaces that may hold SecretRefs. */
export const GATEWAY_AUTH_SURFACE_PATHS = [
  "gateway.auth.token",
  "gateway.auth.password",
  "gateway.remote.token",
  "gateway.remote.password",
] as const;

type GatewayAuthSurfacePath = (typeof GATEWAY_AUTH_SURFACE_PATHS)[number];

/** Active/inactive decision for one gateway credential SecretRef surface. */
type GatewayAuthSurfaceState = {
  active: boolean;
  reason: string;
  hasSecretRef: boolean;
};

/** Complete state map keyed by every known gateway credential surface path. */
type GatewayAuthSurfaceStateMap = Record<GatewayAuthSurfacePath, GatewayAuthSurfaceState>;

function unconfiguredGatewayAuthSurface(): GatewayAuthSurfaceState {
  return { active: false, reason: "gateway configuration is not set.", hasSecretRef: false };
}

/** Evaluates which gateway credential SecretRefs can affect the effective auth plan. */
export function evaluateGatewayAuthSurfaceStates(params: {
  config: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  defaults?: SecretDefaults;
}): GatewayAuthSurfaceStateMap {
  const gateway = params.config.gateway as Record<string, unknown> | undefined;
  if (!isRecord(gateway)) {
    return {
      "gateway.auth.token": unconfiguredGatewayAuthSurface(),
      "gateway.auth.password": unconfiguredGatewayAuthSurface(),
      "gateway.remote.token": unconfiguredGatewayAuthSurface(),
      "gateway.remote.password": unconfiguredGatewayAuthSurface(),
    };
  }
  const auth = isRecord(gateway?.auth) ? gateway.auth : undefined;
  const remote = isRecord(gateway?.remote) ? gateway.remote : undefined;
  const plan = createGatewayCredentialPlan({
    config: params.config,
    env: params.env,
    defaults: params.defaults,
  });

  const localReason = (kind: "token" | "password") => {
    if (!auth) {
      return "gateway.auth is not configured.";
    }
    const password = kind === "password";
    if (password && plan.passwordCanWin) {
      return plan.authMode === "password"
        ? 'gateway.auth.mode is "password".'
        : "no token source can win, so password auth can win.";
    }
    if (
      plan.authMode === "token" ||
      plan.authMode === "none" ||
      plan.authMode === "trusted-proxy" ||
      (!password && plan.authMode === "password")
    ) {
      return `gateway.auth.mode is "${plan.authMode}".`;
    }
    if (plan.envToken) {
      return "gateway token env var is configured.";
    }
    if (password) {
      if (plan.localToken.configured) {
        return "gateway.auth.token is configured.";
      }
      if (plan.remoteToken.configured) {
        return "gateway.remote.token is configured.";
      }
      return "token auth can win.";
    }
    if (plan.envPassword) {
      return "gateway password env var is configured.";
    }
    if (plan.localPassword.configured) {
      return "gateway.auth.password is configured.";
    }
    return "token auth can win (mode is unset and no password source is configured).";
  };
  const authPasswordReason = localReason("password");
  const authTokenReason = localReason("token");

  const remoteSurfaceReason = [
    plan.remoteMode && 'gateway.mode is "remote"',
    plan.remoteUrlConfigured && "gateway.remote.url is configured",
    plan.tailscaleRemoteExposure && 'gateway.tailscale.mode is "serve" or "funnel"',
  ]
    .filter(Boolean)
    .join("; ");

  // Remote credentials can also be local fallbacks; preserve each winning-source diagnostic.
  const remoteReason = (kind: "token" | "password") => {
    if (!remote) {
      return "gateway.remote is not configured.";
    }
    if (plan.remoteConfiguredSurface) {
      return `remote surface is active: ${remoteSurfaceReason}.`;
    }
    const token = kind === "token";
    if (token ? plan.remoteTokenFallbackActive : plan.remotePasswordFallbackActive) {
      return token
        ? "local token auth can win and no env/auth token is configured."
        : "password auth can win and no env/auth password is configured.";
    }
    if (!(token ? plan.localTokenCanWin : plan.passwordCanWin)) {
      if (
        token ||
        plan.authMode === "token" ||
        plan.authMode === "none" ||
        plan.authMode === "trusted-proxy"
      ) {
        return `${kind} auth cannot win with gateway.auth.mode="${plan.authMode ?? "unset"}".`;
      }
      return "a token source can win, so password auth cannot win.";
    }
    if (token ? plan.envToken : plan.envPassword) {
      return `gateway ${kind} env var is configured.`;
    }
    if ((token ? plan.localToken : plan.localPassword).configured) {
      return `gateway.auth.${kind} is configured.`;
    }
    return `remote ${kind} fallback is not active.`;
  };

  return {
    "gateway.auth.token": {
      active: plan.localTokenSurfaceActive,
      reason: authTokenReason,
      hasSecretRef: plan.localToken.hasSecretRef,
    },
    "gateway.auth.password": {
      active: plan.passwordCanWin,
      reason: authPasswordReason,
      hasSecretRef: plan.localPassword.hasSecretRef,
    },
    "gateway.remote.token": {
      active: plan.remoteTokenActive,
      reason: remoteReason("token"),
      hasSecretRef: plan.remoteToken.hasSecretRef,
    },
    "gateway.remote.password": {
      active: plan.remotePasswordActive,
      reason: remoteReason("password"),
      hasSecretRef: plan.remotePassword.hasSecretRef,
    },
  };
}
