// Gateway secret-input path helpers.
// Lists config locations that may contain plaintext values or SecretRefs.
import { copyConfigResolutionFactsExcept } from "../config/resolution-facts.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

/** Canonical Gateway config paths whose values may be plaintext or secret refs. */
export type SupportedGatewaySecretInputPath =
  | "gateway.auth.token"
  | "gateway.auth.password"
  | "gateway.remote.token"
  | "gateway.remote.password";

/** Stable scan order for Gateway secret-ref credential selection. */
export const ALL_GATEWAY_SECRET_INPUT_PATHS: SupportedGatewaySecretInputPath[] = [
  "gateway.auth.token",
  "gateway.auth.password",
  "gateway.remote.token",
  "gateway.remote.password",
];

/** Narrow an arbitrary error/config path to one of the supported Gateway secret inputs. */
export function isSupportedGatewaySecretInputPath(
  path: string,
): path is SupportedGatewaySecretInputPath {
  return ALL_GATEWAY_SECRET_INPUT_PATHS.includes(path as SupportedGatewaySecretInputPath);
}

/** Read a Gateway secret input without assuming whether it is plaintext, a ref, or absent. */
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

/** Replace one Gateway secret input and consume its pending authored provenance atomically. */
export function assignResolvedGatewaySecretInput(params: {
  config: OpenClawConfig;
  path: SupportedGatewaySecretInputPath;
  value: string | undefined;
}): void {
  const { config, path, value } = params;
  const target =
    path === "gateway.auth.token" || path === "gateway.auth.password"
      ? config.gateway?.auth
      : config.gateway?.remote;
  if (target) {
    target[isTokenGatewaySecretInputPath(path) ? "token" : "password"] = value;
    copyConfigResolutionFactsExcept(config, config, [path]);
  }
}

/** Distinguish token paths from password paths for auth-mode precedence checks. */
export function isTokenGatewaySecretInputPath(path: SupportedGatewaySecretInputPath): boolean {
  return path === "gateway.auth.token" || path === "gateway.remote.token";
}
