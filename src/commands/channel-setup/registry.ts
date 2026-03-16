import { listChannelSetupPlugins } from "../../channels/plugins/setup-registry.js";
import { buildChannelSetupFlowAdapterFromSetupWizard } from "../../channels/plugins/setup-wizard.js";
import type { ChannelPlugin } from "../../channels/plugins/types.js";
import type { ChannelChoice } from "../onboard-types.js";
import type { ChannelSetupFlowAdapter } from "./types.js";

const setupWizardAdapters = new WeakMap<object, ChannelSetupFlowAdapter>();

export function resolveChannelSetupFlowAdapterForPlugin(
  plugin?: ChannelPlugin,
): ChannelSetupFlowAdapter | undefined {
  if (plugin?.setupWizard) {
    const cached = setupWizardAdapters.get(plugin);
    if (cached) {
      return cached;
    }
    const adapter = buildChannelSetupFlowAdapterFromSetupWizard({
      plugin,
      wizard: plugin.setupWizard,
    });
    setupWizardAdapters.set(plugin, adapter);
    return adapter;
  }
  return undefined;
}

const CHANNEL_SETUP_FLOW_ADAPTERS = () => {
  const adapters = new Map<ChannelChoice, ChannelSetupFlowAdapter>();
  for (const plugin of listChannelSetupPlugins()) {
    const adapter = resolveChannelSetupFlowAdapterForPlugin(plugin);
    if (!adapter) {
      continue;
    }
    adapters.set(plugin.id, adapter);
  }
  return adapters;
};

export function getChannelSetupFlowAdapter(
  channel: ChannelChoice,
): ChannelSetupFlowAdapter | undefined {
  return CHANNEL_SETUP_FLOW_ADAPTERS().get(channel);
}

export function listChannelSetupFlowAdapters(): ChannelSetupFlowAdapter[] {
  return Array.from(CHANNEL_SETUP_FLOW_ADAPTERS().values());
}
