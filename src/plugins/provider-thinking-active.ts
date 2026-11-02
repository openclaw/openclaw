// Reads provider thinking policy from a prepared or active runtime registry.
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { getProviderRegistryIndex } from "./provider-registry-index.js";
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
  const providers = (registry ?? state?.activeRegistry)?.providers;
  const normalized = normalizeProviderId(params.provider);
  // The shared index lists positions in registry order, so its first hit is the first match.
  const position =
    providers && normalized
      ? getProviderRegistryIndex(providers).refs.get(normalized)?.[0]
      : undefined;
  return position === undefined
    ? undefined
    : providers?.[position]?.provider?.resolveThinkingProfile?.(params.context);
}
