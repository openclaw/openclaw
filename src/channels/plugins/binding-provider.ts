import type { ChannelConfiguredBindingProvider } from "./types.adapters.js";
import type { ChannelPlugin } from "./types.plugin.js";

export function resolveChannelConfiguredBindingProvider(
  plugin:
    | Pick<ChannelPlugin, "bindings" | "acpBindings">
    | {
        bindings?: ChannelConfiguredBindingProvider;
        acpBindings?: ChannelConfiguredBindingProvider;
      }
    | null
    | undefined,
): ChannelConfiguredBindingProvider | undefined {
  // Keep older external plugins working while they migrate from `acpBindings`.
  return plugin?.bindings ?? plugin?.acpBindings;
}
