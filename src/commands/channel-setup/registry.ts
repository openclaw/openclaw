import { listChannelSetupPlugins } from "../../channels/plugins/setup-registry.js";
import { buildChannelSetupWizardAdapterFromSetupWizard } from "../../channels/plugins/setup-wizard.js";
import type { ChannelPlugin } from "../../channels/plugins/types.js";
import type { ChannelChoice } from "../onboard-types.js";
import type { ChannelSetupWizardAdapter } from "./types.js";

const setupWizardAdapters = new WeakMap<object, ChannelSetupWizardAdapter>();

export function resolveChannelSetupWizardAdapterForPlugin(
  plugin?: ChannelPlugin,
): ChannelSetupWizardAdapter | undefined {
  if (plugin?.setupWizard) {
    const cached = setupWizardAdapters.get(plugin);
    if (cached) {
      return cached;
    }
    const adapter = buildChannelSetupWizardAdapterFromSetupWizard({
      plugin,
      wizard: plugin.setupWizard,
    });
    setupWizardAdapters.set(plugin, adapter);
    return adapter;
  }
  return undefined;
}

const getChannelSetupWizardAdapterMap = () => {
  const adapters = new Map<ChannelChoice, ChannelSetupWizardAdapter>();
  for (const plugin of listChannelSetupPlugins()) {
    const adapter = resolveChannelSetupWizardAdapterForPlugin(plugin);
    if (!adapter) {
      continue;
    }
    adapters.set(plugin.id, adapter);
  }
  return adapters;
};

export function getChannelSetupWizardAdapter(
  channel: ChannelChoice,
): ChannelSetupWizardAdapter | undefined {
  return getChannelSetupWizardAdapterMap().get(channel);
}

export function listChannelSetupWizardAdapters(): ChannelSetupWizardAdapter[] {
  return Array.from(getChannelSetupWizardAdapterMap().values());
}
