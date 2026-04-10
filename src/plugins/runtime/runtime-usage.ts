import { estimateUsageCost, resolveModelCostConfig } from "../../utils/usage-format.js";
import type { PluginRuntime } from "./types.js";

export function createRuntimeUsage(): PluginRuntime["usage"] {
  return {
    resolveModelCostConfig,
    estimateUsageCost,
  };
}
