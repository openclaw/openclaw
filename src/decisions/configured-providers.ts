import { findNormalizedProviderValue } from "@openclaw/model-catalog-core/provider-id";
import type { PluginRuntime } from "../plugins/runtime/types.js";

type DecisionConfig = Pick<ReturnType<PluginRuntime["config"]["current"]>, "models">;

/** A configured decision endpoint is distinct from its plugin-owned wire adapter. */
export function resolveConfiguredDecisionProvider(config: DecisionConfig, providerId: string) {
  const provider = findNormalizedProviderValue(config.models?.providers, providerId);
  return provider?.type === "decision" ? provider : undefined;
}

export function resolveDecisionAdapterId(config: DecisionConfig, providerId: string): string {
  return resolveConfiguredDecisionProvider(config, providerId)?.decisionProvider ?? providerId;
}
