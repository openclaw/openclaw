import type {
  ProviderDefaultThinkingPolicyContext,
  ProviderThinkingProfile,
} from "./provider-thinking.types.js";
import type { PluginRegistry } from "./registry-types.js";

/** Process-local policy bound to the prepared generation that supplied its catalog row. */
export type PreparedThinkingPolicy = Readonly<{
  resolve: (
    context: ProviderDefaultThinkingPolicyContext,
  ) => ProviderThinkingProfile | null | undefined;
  /** Runtime policies retain their supplying registry, not prepared-owner currency. */
  pluginRegistry?: PluginRegistry;
}>;

// Internal row metadata follows spreads, but not JSON or worker transport.
export const PREPARED_THINKING_POLICY = Symbol("preparedThinkingPolicy");
export type ThinkingCatalogPolicyCarrier = object & {
  [PREPARED_THINKING_POLICY]?: PreparedThinkingPolicy | null;
};
