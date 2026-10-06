import { normalizeOptionalString } from "../../packages/normalization-core/src/string-coerce.js";
import { containsEnvVarReference } from "../config/env-substitution.js";
import {
  getAuthoredConfigSecretRef,
  getConfigResolutionFacts,
  hasUnresolvedConfigPath,
} from "../config/resolution-facts.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { hasConfiguredSecretInput, resolveSecretInputRef } from "../config/types.secrets.js";
import type { SupportedGatewaySecretInputPath } from "./secret-input-paths.js";

/** Precomputed Gateway credential surfaces used by startup, secret resolution, and clients. */
export type GatewayCredentialPlan = ReturnType<typeof createGatewayCredentialPlan>;

type GatewaySecretDefaults = NonNullable<OpenClawConfig["secrets"]>["defaults"];

/** Normalize optional Gateway credential strings to nonempty values. */
export const trimToUndefined = normalizeOptionalString;

/**
 * Like trimToUndefined but also rejects unresolved env var placeholders (e.g. `${VAR}`).
 * This prevents literal placeholder strings like `${OPENCLAW_GATEWAY_TOKEN}` from being
 * accepted as valid credentials when the referenced env var is missing.
 * Note: legitimate credential values containing literal `${UPPER_CASE}` patterns will
 * also be rejected, but this is an extremely unlikely edge case.
 */
export function trimCredentialToUndefined(value: unknown): string | undefined {
  const trimmed = trimToUndefined(value);
  if (trimmed && containsEnvVarReference(trimmed)) {
    return undefined;
  }
  return trimmed;
}

/** Build the shared credential plan for Gateway startup, local auth, and remote client auth. */
export function createGatewayCredentialPlan(params: {
  config: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  defaults?: GatewaySecretDefaults;
}) {
  const env = params.env ?? process.env;
  const gateway = params.config.gateway;
  const remote = gateway?.remote;
  const defaults = params.defaults ?? params.config.secrets?.defaults;
  const authMode = gateway?.auth?.mode;
  const envToken = trimToUndefined(env.OPENCLAW_GATEWAY_TOKEN);
  const envPassword = trimToUndefined(env.OPENCLAW_GATEWAY_PASSWORD);

  function resolveInput(path: SupportedGatewaySecretInputPath, value: unknown) {
    const resolutionFacts = getConfigResolutionFacts(params.config);
    if (
      hasUnresolvedConfigPath(params.config, path) ||
      getAuthoredConfigSecretRef(params.config, path)
    ) {
      return {
        path,
        configured: true,
        refPath: path,
        hasSecretRef: false,
      };
    }
    if (resolutionFacts !== null && typeof value === "string") {
      return {
        path,
        configured: Boolean(trimToUndefined(value)),
        value: trimToUndefined(value),
        hasSecretRef: false,
      };
    }
    const ref = resolveSecretInputRef({ value, defaults }).ref;
    return {
      path,
      configured: hasConfiguredSecretInput(value, defaults),
      value: ref ? undefined : trimToUndefined(value),
      refPath: ref ? path : undefined,
      hasSecretRef: ref !== null,
    };
  }

  const localToken = resolveInput("gateway.auth.token", gateway?.auth?.token);
  const localPassword = resolveInput("gateway.auth.password", gateway?.auth?.password);
  const remoteToken = resolveInput("gateway.remote.token", remote?.token);
  const remotePassword = resolveInput("gateway.remote.password", remote?.password);

  // The local token surface is disabled by password/none/trusted-proxy modes so
  // token refs do not get resolved for auth modes that cannot consume them.
  const localTokenCanWin =
    authMode !== "password" && authMode !== "none" && authMode !== "trusted-proxy";
  const tokenCanWin = Boolean(envToken || localToken.configured || remoteToken.configured);
  const passwordCanWin =
    authMode === "password" ||
    authMode === "trusted-proxy" ||
    (authMode !== "token" && authMode !== "none" && !tokenCanWin);
  const localTokenSurfaceActive =
    localTokenCanWin &&
    (authMode === "token" ||
      (authMode === undefined && !(envPassword || localPassword.configured)));

  const remoteMode = gateway?.mode === "remote";
  const remoteUrlConfigured = Boolean(trimToUndefined(remote?.url));
  const tailscaleRemoteExposure =
    gateway?.tailscale?.mode === "serve" || gateway?.tailscale?.mode === "funnel";
  // Remote credential surfaces are considered active when the gateway is used
  // remotely or when local auth may be borrowed for a published Tailscale URL.
  const remoteConfiguredSurface = remoteMode || remoteUrlConfigured || tailscaleRemoteExposure;
  // Remote credentials may borrow local auth credentials only when the remote
  // surface exists but no explicit remote/env candidate can satisfy the mode.
  const remoteTokenFallbackActive = localTokenCanWin && !envToken && !localToken.configured;
  const remotePasswordFallbackActive =
    authMode !== "trusted-proxy" && !envPassword && !localPassword.configured && passwordCanWin;

  return {
    configuredMode: gateway?.mode === "remote" ? ("remote" as const) : ("local" as const),
    authMode,
    envToken,
    envPassword,
    localToken,
    localPassword,
    remoteToken,
    remotePassword,
    localTokenCanWin,
    localPasswordCanWin: passwordCanWin,
    localTokenSurfaceActive,
    tokenCanWin,
    passwordCanWin,
    remoteMode,
    remoteUrlConfigured,
    tailscaleRemoteExposure,
    remoteConfiguredSurface,
    remoteTokenFallbackActive,
    remoteTokenActive: remoteConfiguredSurface || remoteTokenFallbackActive,
    remotePasswordFallbackActive,
    remotePasswordActive: remoteConfiguredSurface || remotePasswordFallbackActive,
  };
}
