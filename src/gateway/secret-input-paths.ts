import type { OpenClawConfig } from "../config/types.openclaw.js";

/**
 * Canonical Gateway config paths whose values may be plaintext or secret refs.
 * Keep this union aligned with auth materialization so diagnostics and resolver
 * output name the same config surface.
 */
export type SupportedGatewaySecretInputPath =
  | "gateway.auth.token"
  | "gateway.auth.password"
  | "gateway.remote.token"
  | "gateway.remote.password";

/**
 * Stable scan order for Gateway secret-ref credential selection. Auth-scoped
 * inputs intentionally win before remote inputs so implicit auth mode follows
 * the same precedence as concrete config values.
 */
export const ALL_GATEWAY_SECRET_INPUT_PATHS: SupportedGatewaySecretInputPath[] = [
  "gateway.auth.token",
  "gateway.auth.password",
  "gateway.remote.token",
  "gateway.remote.password",
];

/**
 * Narrow an arbitrary error/config path to one of the supported Gateway secret
 * inputs before reading or mutating a config object by path.
 */
export function isSupportedGatewaySecretInputPath(
  path: string,
): path is SupportedGatewaySecretInputPath {
  return ALL_GATEWAY_SECRET_INPUT_PATHS.includes(path as SupportedGatewaySecretInputPath);
}

/**
 * Read a Gateway secret input without assuming whether it is plaintext, a ref,
 * or absent. The return stays `unknown` because schema validation and secret-ref
 * resolution happen at the caller boundary.
 */
export function readGatewaySecretInputValue(
  config: OpenClawConfig,
  path: SupportedGatewaySecretInputPath,
): unknown {
  if (path === "gateway.auth.token") {
    return config.gateway?.auth?.token;
  }
  if (path === "gateway.auth.password") {
    return config.gateway?.auth?.password;
  }
  if (path === "gateway.remote.token") {
    return config.gateway?.remote?.token;
  }
  return config.gateway?.remote?.password;
}

/**
 * Replace one Gateway secret input with its resolved plaintext value on a cloned
 * config. Missing parent objects are not created here so materialization cannot
 * add auth surfaces the user did not configure.
 */
export function assignResolvedGatewaySecretInput(params: {
  config: OpenClawConfig;
  path: SupportedGatewaySecretInputPath;
  value: string | undefined;
}): void {
  const { config, path, value } = params;
  if (path === "gateway.auth.token") {
    if (config.gateway?.auth) {
      config.gateway.auth.token = value;
    }
    return;
  }
  if (path === "gateway.auth.password") {
    if (config.gateway?.auth) {
      config.gateway.auth.password = value;
    }
    return;
  }
  if (path === "gateway.remote.token") {
    if (config.gateway?.remote) {
      config.gateway.remote.token = value;
    }
    return;
  }
  if (config.gateway?.remote) {
    config.gateway.remote.password = value;
  }
}

/** Distinguish token paths from password paths for auth-mode precedence checks. */
export function isTokenGatewaySecretInputPath(path: SupportedGatewaySecretInputPath): boolean {
  return path === "gateway.auth.token" || path === "gateway.remote.token";
}
