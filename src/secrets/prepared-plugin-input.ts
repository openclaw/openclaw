import { getAuthoredConfigSecretRef } from "../config/resolution-facts.js";
import { coerceSecretRef } from "../config/types.secrets.js";
import { getPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import { formatConcreteConfigPath, parseConcreteConfigPathTokens } from "../shared/dot-path.js";
import { isSecretOwnerAvailable } from "./runtime-degraded-state.js";
import {
  getActiveSecretsRuntimeConfigSnapshot,
  getActiveSecretsRuntimeSnapshotRevisionState,
} from "./runtime-state.js";

/** Read a manifest-prepared capability credential. Never resolves a cold reference or environment. */
export function getPreparedPluginSecretInput(
  pluginId: string,
  path: string,
): { value?: string; revision: number } {
  const revision = getActiveSecretsRuntimeSnapshotRevisionState();
  if (getPluginRuntimeGatewayRequestScope()?.pluginId !== pluginId) {
    return { revision };
  }
  const snapshot = getActiveSecretsRuntimeConfigSnapshot();
  if (
    !snapshot?.configRefsPrepared ||
    snapshot.config.plugins?.enabled === false ||
    snapshot.config.plugins?.entries?.[pluginId]?.enabled === false
  ) {
    return { revision };
  }
  const tokens = ["plugins", "entries", pluginId, "config", ...parseConcreteConfigPathTokens(path)];
  const fullPath = formatConcreteConfigPath(tokens);
  if (!isSecretOwnerAvailable("capability", fullPath)) {
    return { revision };
  }
  const read = (root: unknown): unknown => {
    let value = root;
    for (const token of tokens) {
      if (!value || typeof value !== "object" || !Object.hasOwn(value, token)) {
        return undefined;
      }
      value = Reflect.get(value, token);
    }
    return value;
  };
  const source = read(snapshot.sourceConfig);
  if (
    !coerceSecretRef(source, snapshot.sourceConfig.secrets?.defaults) &&
    !getAuthoredConfigSecretRef(snapshot.sourceConfig, fullPath)
  ) {
    return { revision };
  }
  const value = read(snapshot.config);
  return typeof value === "string" && value.trim() ? { value, revision } : { revision };
}
