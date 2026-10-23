// Reads provider thinking policy from a prepared or active runtime registry.
import { matchesProviderPluginRef } from "./provider-registry-shared.js";
import type {
  ProviderDefaultThinkingPolicyContext,
  ProviderThinkingRegistry,
} from "./provider-thinking.types.js";
import { PLUGIN_REGISTRY_STATE } from "./runtime-state-key.js";

export function resolveActiveProviderThinkingProfile(
  params: { provider: string; context: ProviderDefaultThinkingPolicyContext },
  registry?: ProviderThinkingRegistry,
) {
  const state = (
    globalThis as typeof globalThis & {
      [PLUGIN_REGISTRY_STATE]?: {
        activeRegistry?: ProviderThinkingRegistry | null;
      };
    }
  )[PLUGIN_REGISTRY_STATE];
  return (registry ?? state?.activeRegistry)?.providers
    ?.find((entry) => matchesProviderPluginRef(entry.provider, params.provider))
    ?.provider?.resolveThinkingProfile?.(params.context);
}
