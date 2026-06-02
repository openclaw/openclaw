import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveSecretInputRef } from "../config/types.secrets.js";
import { trimToUndefined } from "./credentials.js";
import {
  resolveConfiguredSecretInputString,
  type SecretInputUnresolvedReasonStyle,
} from "./resolve-configured-secret-input-string.js";

type GatewayAuthTokenResolutionSource = "explicit" | "config" | "secretRef" | "env";
/** Controls whether OPENCLAW_GATEWAY_TOKEN may backfill missing or unresolved config. */
type GatewayAuthTokenEnvFallback = "never" | "no-secret-ref" | "always";

/**
 * Resolves the Gateway auth token for install/status/doctor call sites.
 * Precedence is explicit token, plaintext config, SecretRef, then optional env
 * fallback; unresolved SecretRefs stay visible so callers can decide whether an
 * env token is acceptable or whether the operator must fix the SecretRef.
 */
export async function resolveGatewayAuthToken(params: {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  /** CLI or call-site supplied token; whitespace-only values are ignored. */
  explicitToken?: string;
  /** Defaults to "always"; install paths use stricter modes to avoid persisting env fallbacks. */
  envFallback?: GatewayAuthTokenEnvFallback;
  unresolvedReasonStyle?: SecretInputUnresolvedReasonStyle;
}): Promise<{
  token?: string;
  source?: GatewayAuthTokenResolutionSource;
  /** True when gateway.auth.token was configured as a SecretRef or env template. */
  secretRefConfigured: boolean;
  unresolvedRefReason?: string;
}> {
  const explicitToken = trimToUndefined(params.explicitToken);
  if (explicitToken) {
    return {
      token: explicitToken,
      source: "explicit",
      secretRefConfigured: false,
    };
  }

  const tokenInput = params.cfg.gateway?.auth?.token;
  const tokenRef = resolveSecretInputRef({
    value: tokenInput,
    defaults: params.cfg.secrets?.defaults,
  }).ref;
  const envFallback = params.envFallback ?? "always";
  const envToken = trimToUndefined(params.env.OPENCLAW_GATEWAY_TOKEN);

  if (!tokenRef) {
    const configToken = trimToUndefined(tokenInput);
    if (configToken) {
      return {
        token: configToken,
        source: "config",
        secretRefConfigured: false,
      };
    }
    if (envFallback !== "never" && envToken) {
      return {
        token: envToken,
        source: "env",
        secretRefConfigured: false,
      };
    }
    return { secretRefConfigured: false };
  }

  const resolved = await resolveConfiguredSecretInputString({
    config: params.cfg,
    env: params.env,
    value: tokenInput,
    path: "gateway.auth.token",
    unresolvedReasonStyle: params.unresolvedReasonStyle,
  });
  if (resolved.value) {
    return {
      token: resolved.value,
      source: "secretRef",
      secretRefConfigured: true,
    };
  }
  if (envFallback === "always" && envToken) {
    return {
      token: envToken,
      source: "env",
      secretRefConfigured: true,
    };
  }
  return {
    secretRefConfigured: true,
    unresolvedRefReason: resolved.unresolvedRefReason,
  };
}
