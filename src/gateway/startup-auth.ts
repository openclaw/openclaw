// Gateway startup auth preparation.
// Merges auth overrides, resolves secret refs, validates weak secrets, and generates fallbacks.
import crypto from "node:crypto";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  copyConfigResolutionFactsExcept,
  getConfigResolutionFacts,
} from "../config/resolution-facts.js";
import type { GatewayAuthConfig, GatewayTailscaleConfig } from "../config/types.gateway.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  resolveGatewayPasswordSecretRefValue,
  resolveGatewayTokenSecretRefValue,
} from "./auth-config-utils.js";
import { assertExplicitGatewayAuthModeWhenBothConfigured } from "./auth-mode-policy.js";
import { resolveGatewayAuthForConfig, type ResolvedGatewayAuth } from "./auth-resolve.js";
import { createGatewayCredentialPlan } from "./credential-planner.js";
import { trimToUndefined } from "./credentials.js";
import {
  assertGatewayAuthNotKnownWeak,
  getTrustedProxyPasswordRedactionWarning,
} from "./known-weak-gateway-secrets.js";

const HOOKS_GATEWAY_AUTH_REUSE_WARNING =
  "Security warning: hooks.token matches active Gateway shared-secret auth. Startup continues for compatibility; rotate hooks.token or Gateway auth. Run openclaw security audit for a full report, and run openclaw doctor --fix when the reused hooks.token is persisted in config.";

/** Merge sparse runtime Tailscale overrides into persisted Gateway Tailscale config. */
export function mergeGatewayTailscaleConfig(
  base?: GatewayTailscaleConfig,
  override?: GatewayTailscaleConfig,
): GatewayTailscaleConfig {
  const merged: GatewayTailscaleConfig = { ...base };
  if (!override) {
    return merged;
  }
  if (override.mode !== undefined) {
    merged.mode = override.mode;
  }
  if (override.preserveFunnel !== undefined) {
    merged.preserveFunnel = override.preserveFunnel;
  }
  return merged;
}

function findActiveGatewaySharedSecret(auth: ResolvedGatewayAuth): string {
  if (auth.mode === "token") {
    return normalizeOptionalString(auth.token) ?? "";
  }
  if (auth.mode === "password" || auth.mode === "trusted-proxy") {
    return normalizeOptionalString(auth.password) ?? "";
  }
  return "";
}

function warnHooksTokenReuseGatewayAuth(params: {
  cfg: OpenClawConfig;
  auth: ResolvedGatewayAuth;
  warn?: (message: string) => void;
}): void {
  if (params.cfg.hooks?.enabled !== true || !params.warn) {
    return;
  }
  const hooksToken = normalizeOptionalString(params.cfg.hooks.token) ?? "";
  if (!hooksToken || hooksToken !== findActiveGatewaySharedSecret(params.auth)) {
    return;
  }
  params.warn(HOOKS_GATEWAY_AUTH_REUSE_WARNING);
}

/** Check every source that can satisfy token auth before startup generates one. */
function hasGatewayTokenCandidate(params: {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  authOverride?: GatewayAuthConfig;
}): boolean {
  const envToken = trimToUndefined(params.env.OPENCLAW_GATEWAY_TOKEN);
  if (envToken) {
    return true;
  }
  if (normalizeOptionalString(params.authOverride?.token)) {
    return true;
  }
  const token = createGatewayCredentialPlan({
    config: params.cfg,
    env: params.env,
  }).localToken;
  return token.hasSecretRef || Boolean(token.value);
}

/** Ensure startup has effective Gateway auth, generating only an ephemeral token if needed. */
export async function ensureGatewayStartupAuth(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  authOverride?: GatewayAuthConfig;
  tailscaleOverride?: GatewayTailscaleConfig;
  warn?: (message: string) => void;
  /**
   * Legacy startup option retained for external callers. Startup-generated auth
   * is runtime-only; durable auth changes must go through explicit config tools.
   */
  persist?: boolean;
  baseHash?: string;
}): Promise<{
  cfg: OpenClawConfig;
  auth: ResolvedGatewayAuth;
  generatedToken?: string;
  persistedGeneratedToken: boolean;
}> {
  assertExplicitGatewayAuthModeWhenBothConfigured(params.cfg);
  const env = params.env ?? process.env;
  const explicitMode = params.authOverride?.mode ?? params.cfg.gateway?.auth?.mode;
  const credentialPlan = createGatewayCredentialPlan({ config: params.cfg, env });
  const resolutionEvaluated = getConfigResolutionFacts(params.cfg) !== null;
  const tokenAlreadySubstituted =
    resolutionEvaluated && typeof params.cfg.gateway?.auth?.token === "string";
  const passwordAlreadySubstituted =
    resolutionEvaluated && typeof params.cfg.gateway?.auth?.password === "string";
  const hasTokenOverride =
    Boolean(normalizeOptionalString(params.authOverride?.token)) || tokenAlreadySubstituted;
  const hasPasswordOverride =
    Boolean(normalizeOptionalString(params.authOverride?.password)) || passwordAlreadySubstituted;
  // Resolve only refs that can satisfy the effective mode; inactive refs stay
  // as refs so startup does not require unrelated secret providers.
  const [resolvedTokenRefValue, resolvedPasswordRefValue] = await Promise.all([
    resolveGatewayTokenSecretRefValue({
      cfg: params.cfg,
      env,
      mode: explicitMode,
      hasTokenOverride,
      hasPasswordOverride,
      hasTokenFallback: Boolean(trimToUndefined(env.OPENCLAW_GATEWAY_TOKEN)),
      hasPasswordFallback: Boolean(
        credentialPlan.envPassword ||
        credentialPlan.localPassword.value ||
        credentialPlan.localPassword.hasSecretRef,
      ),
    }),
    resolveGatewayPasswordSecretRefValue({
      cfg: params.cfg,
      env,
      mode: explicitMode,
      hasPasswordOverride,
      hasTokenOverride,
      hasPasswordFallback: Boolean(trimToUndefined(env.OPENCLAW_GATEWAY_PASSWORD)),
      hasTokenFallback: hasGatewayTokenCandidate({
        cfg: params.cfg,
        env,
        authOverride: params.authOverride,
      }),
    }),
  ]);
  const authOverride: GatewayAuthConfig | undefined =
    params.authOverride || resolvedTokenRefValue || resolvedPasswordRefValue
      ? {
          ...params.authOverride,
          ...(resolvedTokenRefValue ? { token: resolvedTokenRefValue } : {}),
          ...(resolvedPasswordRefValue ? { password: resolvedPasswordRefValue } : {}),
        }
      : undefined;
  const tokenCandidate = hasGatewayTokenCandidate({
    cfg: params.cfg,
    env,
    authOverride,
  });
  const resolutionConfig = tokenCandidate
    ? params.cfg
    : {
        ...params.cfg,
        gateway: {
          ...params.cfg.gateway,
          auth: { ...params.cfg.gateway?.auth, token: undefined },
        },
      };
  if (resolutionConfig !== params.cfg) {
    copyConfigResolutionFactsExcept(params.cfg, resolutionConfig, ["gateway.auth.token"]);
  }
  const tailscaleMode =
    mergeGatewayTailscaleConfig(resolutionConfig.gateway?.tailscale, params.tailscaleOverride)
      .mode ?? "off";
  const resolved = resolveGatewayAuthForConfig({
    config: resolutionConfig,
    env,
    authOverride,
    tailscaleMode,
  });
  assertGatewayAuthNotKnownWeak(
    resolved,
    authOverride?.token ?? params.cfg.gateway?.auth?.token,
    authOverride?.password ?? params.cfg.gateway?.auth?.password,
  );
  const optionalPasswordWarning = getTrustedProxyPasswordRedactionWarning(resolved);
  if (optionalPasswordWarning) {
    params.warn?.(optionalPasswordWarning);
  }
  if (resolved.mode !== "token" || (resolved.token?.trim().length ?? 0) > 0) {
    warnHooksTokenReuseGatewayAuth({ cfg: params.cfg, auth: resolved, warn: params.warn });
    return { cfg: params.cfg, auth: resolved, persistedGeneratedToken: false };
  }

  const generatedToken = crypto.randomBytes(24).toString("hex");
  const nextCfg: OpenClawConfig = {
    ...params.cfg,
    gateway: {
      ...params.cfg.gateway,
      auth: {
        ...params.cfg.gateway?.auth,
        mode: "token",
        token: generatedToken,
      },
    },
  };
  copyConfigResolutionFactsExcept(params.cfg, nextCfg, ["gateway.auth.token"]);
  const nextAuth = resolveGatewayAuthForConfig({
    config: nextCfg,
    env,
    authOverride: params.authOverride,
    tailscaleMode,
  });
  assertGatewayAuthNotKnownWeak(nextAuth);
  warnHooksTokenReuseGatewayAuth({ cfg: nextCfg, auth: nextAuth, warn: params.warn });
  return {
    cfg: nextCfg,
    auth: nextAuth,
    generatedToken,
    persistedGeneratedToken: false,
  };
}
