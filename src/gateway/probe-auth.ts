// Gateway probe auth resolver.
// Adapts gateway credential precedence for local/remote reachability checks.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  describeSecretResolutionOperatorDiagnostic,
  describeSecretResolutionOperatorRecovery,
  isSecretResolutionError,
} from "../secrets/resolve-errors.js";
import { resolveGatewayProbeSurfaceAuth } from "./auth-surface-resolution.js";
import { createGatewayCredentialPlan } from "./credential-planner.js";
import { resolveGatewayCredentialsWithSecretInputs } from "./credentials-secret-inputs.js";
import {
  type ExplicitGatewayAuth,
  type GatewayCredentialPrecedence,
  isGatewaySecretRefUnavailableError,
  resolveExplicitGatewayAuth,
  resolveGatewayProbeCredentialsFromConfig,
} from "./credentials.js";
import { getTrustedProxyPasswordRedactionWarning } from "./known-weak-gateway-secrets.js";
export { resolveGatewayProbeTarget } from "./probe-target.js";
export type { GatewayProbeTargetResolution } from "./probe-target.js";

type GatewayProbeCredentialParams = {
  cfg: OpenClawConfig;
  mode: "local" | "remote";
  env?: NodeJS.ProcessEnv;
  explicitAuth?: ExplicitGatewayAuth;
  urlOverride?: string;
  urlOverrideSource?: "cli" | "env";
  localPrecedence?: GatewayCredentialPrecedence;
};

export function resolveGatewayProbeCredentialConfig(params: {
  cfg: OpenClawConfig;
  mode: "local" | "remote";
}): OpenClawConfig {
  const gateway = params.cfg.gateway;
  const credentials = params.mode === "local" ? gateway?.remote : gateway?.auth;
  if (!credentials || (credentials.token === undefined && credentials.password === undefined)) {
    return params.cfg;
  }

  // A probe may only use credentials owned by its target surface. Otherwise a
  // healthy result can both target the wrong Gateway and disclose its peer's secret.
  const credentialsWithoutAuth = { ...credentials };
  delete credentialsWithoutAuth.token;
  delete credentialsWithoutAuth.password;
  return {
    ...params.cfg,
    gateway: {
      ...gateway,
      ...(params.mode === "local"
        ? { remote: credentialsWithoutAuth }
        : { auth: credentialsWithoutAuth }),
    },
  };
}

function hasExplicitProbeAuth(auth: { token?: string; password?: string }): boolean {
  return Boolean(auth.token || auth.password);
}

function resolveGatewayProbeWarning(error: unknown): string | undefined {
  if (!isGatewaySecretRefUnavailableError(error)) {
    throw error;
  }
  return `${error.path} SecretRef is unresolved in this command path; probing without configured auth credentials.`;
}

/** Resolves synchronous probe auth, throwing when configured secrets cannot be read. */
export function resolveGatewayProbeAuth(
  params: Omit<GatewayProbeCredentialParams, "explicitAuth" | "localPrecedence">,
): { token?: string; password?: string } {
  return resolveGatewayProbeCredentialsFromConfig({
    ...params,
    cfg: resolveGatewayProbeCredentialConfig(params),
  });
}

async function resolveGatewayProbeAuthResolutionWithSecretInputs(
  params: GatewayProbeCredentialParams,
): Promise<{
  auth: { token?: string; password?: string };
  warning?: string;
  warningCode?: "SECRET_REF_REDACTED_VALUE";
}> {
  const config = resolveGatewayProbeCredentialConfig(params);
  const plan =
    params.mode === "local" && params.localPrecedence === "env-first"
      ? createGatewayCredentialPlan({ config, env: params.env })
      : undefined;
  const activeLocalRef =
    (plan?.localTokenCanWin && plan.localToken.hasSecretRef) ||
    ((plan?.localPasswordCanWin || plan?.authMode === undefined) &&
      plan?.localPassword.hasSecretRef);
  const explicitAuth = resolveExplicitGatewayAuth(params.explicitAuth);
  if (
    (params.mode === "remote" || activeLocalRef) &&
    !hasExplicitProbeAuth(explicitAuth) &&
    !normalizeOptionalString(params.urlOverride)
  ) {
    // Remote and SecretRef-owned local probes must share their target's
    // credential owner so ambient auth cannot mask the configured secret.
    const resolved = await resolveGatewayProbeSurfaceAuth({
      config,
      env: params.env,
      surface: params.mode,
    });
    const warning = resolved.diagnostics?.join("\n");
    if (warning) {
      // Keep a resolved sibling config credential, never ambient fallback.
      return {
        auth:
          resolved.source === "config"
            ? { token: resolved.token, password: resolved.password }
            : {},
        warning,
        ...(resolved.warningCode ? { warningCode: resolved.warningCode } : {}),
      };
    }
    return {
      auth: { token: resolved.token, password: resolved.password },
    };
  }
  const auth = await resolveGatewayCredentialsWithSecretInputs({
    config,
    env: params.env,
    explicitAuth: params.explicitAuth,
    urlOverride: params.urlOverride,
    urlOverrideSource: params.urlOverrideSource,
    modeOverride: params.mode,
    // Active SecretRefs must not be bypassed by ambient plaintext credentials.
    localPrecedence: activeLocalRef ? "config-first" : params.localPrecedence,
    remoteTokenFallback: "remote-only",
  });
  return { auth };
}

/** Resolves probe auth without throwing for unavailable SecretRefs, returning a warning. */
export async function resolveGatewayProbeAuthSafeWithSecretInputs(
  params: GatewayProbeCredentialParams,
): Promise<{
  auth: { token?: string; password?: string };
  warning?: string;
  warningCode?: "SECRET_REF_REDACTED_VALUE";
}> {
  const explicitAuth = resolveExplicitGatewayAuth(params.explicitAuth);
  if (hasExplicitProbeAuth(explicitAuth)) {
    return {
      auth: explicitAuth,
    };
  }

  try {
    const resolution = await resolveGatewayProbeAuthResolutionWithSecretInputs(params);
    if (params.mode === "local" && params.cfg.gateway?.auth?.mode === "trusted-proxy") {
      const warning = getTrustedProxyPasswordRedactionWarning({
        mode: "trusted-proxy",
        password: resolution.auth.password,
      });
      if (warning) {
        return { auth: {}, warning, warningCode: "SECRET_REF_REDACTED_VALUE" };
      }
    }
    return resolution;
  } catch (error) {
    if (isSecretResolutionError(error) && error.code === "SECRET_REF_REDACTED_VALUE") {
      return {
        auth: {},
        warning: [
          describeSecretResolutionOperatorDiagnostic(error),
          describeSecretResolutionOperatorRecovery(error),
        ]
          .filter(Boolean)
          .join(". "),
        warningCode: error.code,
      };
    }
    return {
      auth: {},
      warning: resolveGatewayProbeWarning(error),
    };
  }
}

/** Synchronous safe probe auth wrapper for config-only credential paths. */
export function resolveGatewayProbeAuthSafe(
  params: Omit<GatewayProbeCredentialParams, "localPrecedence">,
): {
  auth: { token?: string; password?: string };
  warning?: string;
} {
  const explicitAuth = resolveExplicitGatewayAuth(params.explicitAuth);
  if (hasExplicitProbeAuth(explicitAuth)) {
    return {
      auth: explicitAuth,
    };
  }

  try {
    return { auth: resolveGatewayProbeAuth(params) };
  } catch (error) {
    return {
      auth: {},
      warning: resolveGatewayProbeWarning(error),
    };
  }
}
