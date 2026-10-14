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
  return selectApplicableRuntimeConfig({
    inputConfig,
    runtimeConfig: getRuntimeConfigSnapshot(),
    runtimeSourceConfig: getRuntimeConfigSourceSnapshot(),
  });
}
