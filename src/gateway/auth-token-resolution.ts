import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveSecretInputRef } from "../config/types.secrets.js";
import { trimToUndefined } from "./credentials.js";
import {
  resolveConfiguredSecretInputString,
  type SecretInputUnresolvedReasonStyle,
} from "./resolve-configured-secret-input-string.js";

type GatewayAuthTokenResolutionSource = "explicit" | "config" | "secretRef" | "env";
type GatewayAuthTokenEnvFallback = "never" | "no-secret-ref" | "always";

function withGatewayTokenEnvAlias(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const canonical = trimToUndefined(env.OPENCLAW_GATEWAY_TOKEN);
  const legacy = trimToUndefined(env.OPENCLAW_GATEWAY_AUTH_TOKEN);
  if (canonical || !legacy) {
    return env;
  }
  return {
    ...env,
    OPENCLAW_GATEWAY_TOKEN: legacy,
  };
}

export async function resolveGatewayAuthToken(params: {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  explicitToken?: string;
  envFallback?: GatewayAuthTokenEnvFallback;
  unresolvedReasonStyle?: SecretInputUnresolvedReasonStyle;
}): Promise<{
  token?: string;
  source?: GatewayAuthTokenResolutionSource;
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
  const env = withGatewayTokenEnvAlias(params.env);
  const envToken = trimToUndefined(env.OPENCLAW_GATEWAY_TOKEN);

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
    env,
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
