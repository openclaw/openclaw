// Gateway auth config utilities materialize token/password SecretRefs only for
// the auth mode that can actually consume them.
import type { GatewayAuthConfig } from "../config/types.gateway.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { hasConfiguredSecretInput, resolveSecretInputRef } from "../config/types.secrets.js";
import { resolveRequiredConfiguredSecretRefInputString } from "./resolve-configured-secret-input-string.js";
import {
  assignResolvedGatewaySecretInput,
  readGatewaySecretInputValue,
  type SupportedGatewaySecretInputPath,
} from "./secret-input-paths.js";

type GatewayAuthSecretInputPath = Extract<
  SupportedGatewaySecretInputPath,
  "gateway.auth.token" | "gateway.auth.password"
>;

type GatewayAuthSecretRefResolutionParams = {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  mode?: GatewayAuthConfig["mode"];
  hasPasswordOverride: boolean;
  hasTokenOverride: boolean;
  hasPasswordFallback: boolean;
  hasTokenFallback: boolean;
};

/** Check whether a local Gateway auth input is configured directly or through defaults. */
export function hasConfiguredGatewayAuthSecretInput(
  cfg: OpenClawConfig,
  path: GatewayAuthSecretInputPath,
): boolean {
  return hasConfiguredSecretInput(readGatewaySecretInputValue(cfg, path), cfg.secrets?.defaults);
}

/** Decide whether a token/password secret ref can be active for the configured auth mode. */
function shouldResolveGatewayAuthSecretRef(
  params: GatewayAuthSecretRefResolutionParams,
  path: GatewayAuthSecretInputPath,
): boolean {
  const isTokenPath = path === "gateway.auth.token";
  const hasPathOverride = isTokenPath ? params.hasTokenOverride : params.hasPasswordOverride;
  if (hasPathOverride) {
    return false;
  }
  if (params.mode === (isTokenPath ? "token" : "password")) {
    return true;
  }
  if (params.mode === "trusted-proxy") {
    return !isTokenPath;
  }
  if (params.mode === "token" || params.mode === "none") {
    return false;
  }
  if (params.mode === "password") {
    return !isTokenPath;
  }
  // With implicit mode, resolve the side that does not already have a concrete
  // competing credential so token and password defaults do not both get materialized.
  return isTokenPath
    ? !(params.hasPasswordOverride || params.hasPasswordFallback)
    : !(params.hasTokenOverride || params.hasTokenFallback);
}

function hasActiveExecGatewayAuthSecretRef(
  params: GatewayAuthSecretRefResolutionParams,
  path: GatewayAuthSecretInputPath,
): boolean {
  if (!shouldResolveGatewayAuthSecretRef(params, path)) {
    return false;
  }
  const { ref } = resolveSecretInputRef({
    value: readGatewaySecretInputValue(params.cfg, path),
    defaults: params.cfg.secrets?.defaults,
  });
  return ref?.source === "exec";
}

/** Check whether active local Gateway auth refs can be read without invoking exec providers. */
export function canMaterializeGatewayAuthSecretRefsWithoutExec(
  params: GatewayAuthSecretRefResolutionParams,
): boolean {
  return !(
    hasActiveExecGatewayAuthSecretRef(params, "gateway.auth.token") ||
    hasActiveExecGatewayAuthSecretRef(params, "gateway.auth.password")
  );
}

async function resolveGatewayAuthSecretRefValue(
  params: GatewayAuthSecretRefResolutionParams,
  path: GatewayAuthSecretInputPath,
): Promise<string | undefined> {
  if (!shouldResolveGatewayAuthSecretRef(params, path)) {
    return undefined;
  }
  const value = await resolveRequiredConfiguredSecretRefInputString({
    config: params.cfg,
    env: params.env,
    value: readGatewaySecretInputValue(params.cfg, path),
    path,
  });
  if (!value) {
    return undefined;
  }
  return value;
}

/** Resolve the Gateway auth token ref only when token auth can use it. */
export async function resolveGatewayTokenSecretRefValue(
  params: GatewayAuthSecretRefResolutionParams,
): Promise<string | undefined> {
  return resolveGatewayAuthSecretRefValue(params, "gateway.auth.token");
}

/** Resolve the Gateway auth password ref only when password auth can use it. */
export async function resolveGatewayPasswordSecretRefValue(
  params: GatewayAuthSecretRefResolutionParams,
): Promise<string | undefined> {
  return resolveGatewayAuthSecretRefValue(params, "gateway.auth.password");
}

async function resolveGatewayAuthSecretRef(
  params: GatewayAuthSecretRefResolutionParams,
  path: GatewayAuthSecretInputPath,
): Promise<OpenClawConfig> {
  const cfg = params.cfg;
  const value = await resolveGatewayAuthSecretRefValue(params, path);
  if (!value) {
    return cfg;
  }
  // Mutate a clone so startup validation can materialize secrets without
  // altering the caller's raw config object.
  const nextConfig = structuredClone(cfg);
  nextConfig.gateway ??= {};
  nextConfig.gateway.auth ??= {};
  assignResolvedGatewaySecretInput({
    config: nextConfig,
    path,
    value,
  });
  return nextConfig;
}

/** Materialize active local Gateway auth secret refs on a cloned config. */
export async function materializeGatewayAuthSecretRefs(
  params: GatewayAuthSecretRefResolutionParams,
): Promise<OpenClawConfig> {
  const cfgWithToken = await resolveGatewayAuthSecretRef(params, "gateway.auth.token");
  return await resolveGatewayAuthSecretRef(
    {
      ...params,
      cfg: cfgWithToken,
      hasTokenFallback:
        params.hasTokenFallback ||
        hasConfiguredGatewayAuthSecretInput(cfgWithToken, "gateway.auth.token"),
    },
    "gateway.auth.password",
  );
}
