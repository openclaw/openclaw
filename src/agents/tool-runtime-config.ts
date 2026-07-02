// Selects the resolved runtime snapshot for agent tool surfaces.
import {
  getRuntimeConfigSnapshot,
  getRuntimeConfigSourceSnapshot,
  selectApplicableRuntimeConfig,
} from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

export function resolveAgentRuntimeToolConfig(
  inputConfig?: OpenClawConfig,
): OpenClawConfig | undefined {
  const runtimeConfig = getRuntimeConfigSnapshot() ?? undefined;
  if (!runtimeConfig) {
    return inputConfig;
  }
  if (!inputConfig || inputConfig === runtimeConfig) {
    return runtimeConfig;
  }
  const runtimeSourceConfig = getRuntimeConfigSourceSnapshot() ?? undefined;
  if (!runtimeSourceConfig) {
    return inputConfig;
  }
  return selectApplicableRuntimeConfig({
    inputConfig,
    runtimeConfig,
    runtimeSourceConfig,
  });
}
