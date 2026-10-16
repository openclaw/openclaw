import type { ChannelSetupWizardAdapter } from "../../channels/plugins/setup-wizard-types.js";
// Adapts declarative and imperative channel setup wizards to the command-facing interface.
import { buildChannelSetupWizardAdapterFromSetupWizard } from "../../channels/plugins/setup-wizard.js";
import type { AnyChannelPlugin as ChannelPlugin } from "../../channels/plugins/types.plugin.js";

const setupWizardAdapters = new WeakMap<object, ChannelSetupWizardAdapter>();

/** Resolve the setup wizard adapter exposed by one channel plugin, caching declarative adapters. */
export function resolveChannelSetupWizardAdapterForPlugin(
  plugin?: ChannelPlugin,
): ChannelSetupWizardAdapter | undefined {
  if (!plugin) {
    return undefined;
  }
  const { setupWizard } = plugin;
  if (!setupWizard) {
    return undefined;
  }
  if ("getStatus" in setupWizard) {
    return setupWizard;
  }
  const cached = setupWizardAdapters.get(plugin);
  if (cached) {
    return cached;
  }
  const adapter = buildChannelSetupWizardAdapterFromSetupWizard({
    plugin,
    wizard: setupWizard,
  });
  setupWizardAdapters.set(plugin, adapter);
  return adapter;
}
