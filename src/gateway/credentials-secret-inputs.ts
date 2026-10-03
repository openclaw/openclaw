// Gateway credential secret-input resolver.
// Resolves SecretRefs before applying Gateway credential precedence rules.
import {
  cloneConfigWithResolutionFacts,
  resolveConfigSecretRef,
} from "../config/resolution-facts.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isSecretResolutionError } from "../secrets/resolve-errors.js";
import { materializeSecretInput } from "../secrets/resolve-secret-input-string.js";
import {
  GatewaySecretRefUnavailableError,
  resolveExplicitGatewayAuth,
  resolveGatewayCredentialsFromConfig,
  trimToUndefined,
  type GatewayCredentialMode,
} from "./credentials.js";
import {
  ALL_GATEWAY_SECRET_INPUT_PATHS,
  assignResolvedGatewaySecretInput,
  isSupportedGatewaySecretInputPath,
  isTokenGatewaySecretInputPath,
  readGatewaySecretInputValue,
  type SupportedGatewaySecretInputPath,
} from "./secret-input-paths.js";

type GatewayCredentialSecretInputOptions = Omit<
  Parameters<typeof resolveGatewayCredentialsFromConfig>[0],
  "cfg"
> & {
  config: OpenClawConfig;
};

async function resolveConfiguredGatewaySecretInput(params: {
  config: OpenClawConfig;
  path: SupportedGatewaySecretInputPath;
  env: NodeJS.ProcessEnv;
}): Promise<string | undefined> {
  const configuredValue = readGatewaySecretInputValue(params.config, params.path);
  const ref = resolveConfigSecretRef({
    config: params.config,
    path: params.path,
    value: configuredValue,
    defaults: params.config.secrets?.defaults,
  });
  const value = await materializeSecretInput({
    config: params.config,
    value: ref ?? configuredValue,
    env: params.env,
    normalize: trimToUndefined,
    onResolveRefError: (error) => {
      if (isSecretResolutionError(error) && error.code === "SECRET_REF_REDACTED_VALUE") {
        throw error;
      }
      throw new GatewaySecretRefUnavailableError(params.path);
    },
  });
  if (!value) {
    throw new Error(`${params.path} resolved to an empty or non-string value.`);
  }
  return value;
}

function hasConfiguredGatewaySecretRef(
  config: OpenClawConfig,
  path: SupportedGatewaySecretInputPath,
): boolean {
  return Boolean(
    resolveConfigSecretRef({
      config,
      path,
      value: readGatewaySecretInputValue(config, path),
      defaults: config.secrets?.defaults,
    }),
  );
}

function localAuthModeAllowsGatewaySecretInputPath(params: {
  authMode: string | undefined;
  path: SupportedGatewaySecretInputPath;
}): boolean {
  const { authMode, path } = params;
  if (authMode === "none") {
    return false;
  }
  if (authMode === "trusted-proxy") {
    return !isTokenGatewaySecretInputPath(path);
  }
  if (authMode === "token") {
    return isTokenGatewaySecretInputPath(path);
  }
  if (authMode === "password") {
    return !isTokenGatewaySecretInputPath(path);
  }
  return true;
}

function canGatewaySecretInputPathWin(params: {
  options: GatewayCredentialSecretInputOptions;
  env: NodeJS.ProcessEnv;
  config: OpenClawConfig;
  path: SupportedGatewaySecretInputPath;
}): boolean {
  if (!hasConfiguredGatewaySecretRef(params.config, params.path)) {
    return false;
  }
  const mode: GatewayCredentialMode =
    params.options.modeOverride ?? (params.config.gateway?.mode === "remote" ? "remote" : "local");
  if (
    mode === "local" &&
    !localAuthModeAllowsGatewaySecretInputPath({
      authMode: params.config.gateway?.auth?.mode,
      path: params.path,
    })
  ) {
    return false;
  }
  const sentinel = `__OPENCLAW_GATEWAY_SECRET_REF_PROBE_${params.path.replaceAll(".", "_")}__`;
  const probeConfig = cloneConfigWithResolutionFacts(params.config);
  for (const candidatePath of ALL_GATEWAY_SECRET_INPUT_PATHS) {
    if (!hasConfiguredGatewaySecretRef(probeConfig, candidatePath)) {
      continue;
    }
    assignResolvedGatewaySecretInput({
      config: probeConfig,
      path: candidatePath,
      value: undefined,
    });
  }
  // Inject one path at a time so normal credential precedence decides whether
  // that secret ref is on the active auth path without resolving real secrets.
  assignResolvedGatewaySecretInput({
    config: probeConfig,
    path: params.path,
    value: sentinel,
  });
  try {
    const resolved = resolveGatewayCredentialsFromConfig({
      ...params.options,
      cfg: probeConfig,
      env: params.env,
    });
    const authMode = params.config.gateway?.auth?.mode;
    const tokenCanWin =
      resolved.token === sentinel &&
      ((mode === "local" && authMode === "token") || !resolved.password);
    const passwordCanWin =
      resolved.password === sentinel &&
      ((mode === "local" && (authMode === "password" || authMode === "trusted-proxy")) ||
        !resolved.token);
    return tokenCanWin || passwordCanWin;
  } catch {
    return false;
  }
}

/** Test whether resolving a configured secret-ref path could affect selected credentials. */
export function gatewaySecretInputPathCanWin(
  params: GatewayCredentialSecretInputOptions & { path: SupportedGatewaySecretInputPath },
): boolean {
  const { path, env = process.env, ...options } = params;
  return canGatewaySecretInputPathWin({
    options: {
      ...options,
      explicitAuth: resolveExplicitGatewayAuth(options.explicitAuth),
    },
    env,
    config: params.config,
    path,
  });
}

/** Resolve only secret refs that can win, then select Gateway credentials. */
export async function resolveGatewayCredentialsWithSecretInputs(
  params: GatewayCredentialSecretInputOptions,
): Promise<{ token?: string; password?: string }> {
  const explicitAuth = resolveExplicitGatewayAuth(params.explicitAuth);
  if (explicitAuth.token || explicitAuth.password) {
    return explicitAuth;
  }
  const options = { ...params, explicitAuth };
  const env = options.env ?? process.env;
  const config = options.config;
  let resolvedConfig = config;
  for (const path of ALL_GATEWAY_SECRET_INPUT_PATHS) {
    if (!canGatewaySecretInputPathWin({ options, env, config: resolvedConfig, path })) {
      continue;
    }
    if (resolvedConfig === config) {
      resolvedConfig = cloneConfigWithResolutionFacts(config);
    }
    try {
      const value = await resolveConfiguredGatewaySecretInput({
        config: resolvedConfig,
        path,
        env,
      });
      assignResolvedGatewaySecretInput({ config: resolvedConfig, path, value });
    } catch (error) {
      if (isSecretResolutionError(error) && error.code === "SECRET_REF_REDACTED_VALUE") {
        throw error;
      }
      // Keep scanning candidate paths so unresolved higher-priority refs do not
      // prevent valid fallback refs from being considered.
    }
  }
  const resolvedPaths = new Set<SupportedGatewaySecretInputPath>();
  for (;;) {
    try {
      return resolveGatewayCredentialsFromConfig({ ...options, cfg: resolvedConfig, env });
    } catch (error) {
      if (!(error instanceof GatewaySecretRefUnavailableError)) {
        throw error;
      }
      const path = error.path;
      if (!isSupportedGatewaySecretInputPath(path) || resolvedPaths.has(path)) {
        throw error;
      }
      if (resolvedConfig === config) {
        resolvedConfig = cloneConfigWithResolutionFacts(config);
      }
      // Resolve refs lazily on demand as a backstop for precedence cases the
      // optimistic scan skipped, but stop if the same path loops.
      const value = await resolveConfiguredGatewaySecretInput({
        config: resolvedConfig,
        path,
        env,
      });
      assignResolvedGatewaySecretInput({ config: resolvedConfig, path, value });
      resolvedPaths.add(path);
    }
  }
}
