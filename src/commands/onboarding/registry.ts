import { listChannelSetupPlugins } from "../../channels/plugins/setup-registry.js";
import { buildChannelOnboardingAdapterFromSetupWizard } from "../../channels/plugins/setup-wizard.js";
import type { ChannelChoice } from "../onboard-types.js";
import type { ChannelOnboardingAdapter } from "./types.js";

const setupWizardAdapters = new WeakMap<object, ChannelOnboardingAdapter>();

function resolveChannelOnboardingAdapter(
  plugin: ReturnType<typeof listChannelSetupPlugins>[number],
): ChannelOnboardingAdapter | undefined {
  if (plugin.setupWizard) {
    const cached = setupWizardAdapters.get(plugin);
    if (cached) {
      return cached;
    }
    const adapter = buildChannelOnboardingAdapterFromSetupWizard({
      plugin,
      wizard: plugin.setupWizard,
    });
    setupWizardAdapters.set(plugin, adapter);
    return adapter;
  }
  if (plugin.onboarding) {
    return plugin.onboarding;
  }
  return undefined;
}

const CHANNEL_ONBOARDING_ADAPTERS = () => {
  const adapters = new Map<ChannelChoice, ChannelOnboardingAdapter>();
  for (const plugin of listChannelSetupPlugins()) {
    const adapter = resolveChannelOnboardingAdapter(plugin);
    if (!adapter) {
      continue;
    }
    adapters.set(plugin.id, adapter);
  }
  return adapters;
};

export function getChannelOnboardingAdapter(
  channel: ChannelChoice,
): ChannelOnboardingAdapter | undefined {
  return CHANNEL_ONBOARDING_ADAPTERS().get(channel);
}

export function listChannelOnboardingAdapters(): ChannelOnboardingAdapter[] {
  return Array.from(CHANNEL_ONBOARDING_ADAPTERS().values());
}

// Legacy aliases (pre-rename).
export const getProviderOnboardingAdapter = getChannelOnboardingAdapter;
export const listProviderOnboardingAdapters = listChannelOnboardingAdapters;
