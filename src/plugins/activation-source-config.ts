import {
  getRuntimeConfigSnapshot,
  getRuntimeConfigSourceSnapshot,
} from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

/**
 * Returns the raw/source config used for activation decisions when normalized
 * runtime snapshots would hide legacy enablement or allowlist intent.
 */
export function resolvePluginActivationSourceConfig(params: {
  config?: OpenClawConfig;
  activationSourceConfig?: OpenClawConfig;
}): OpenClawConfig {
  if (params.activationSourceConfig !== undefined) {
    return params.activationSourceConfig;
  }
  const sourceSnapshot = getRuntimeConfigSourceSnapshot();
  if (sourceSnapshot && params.config === getRuntimeConfigSnapshot()) {
    return sourceSnapshot;
  }
  return params.config ?? {};
}
