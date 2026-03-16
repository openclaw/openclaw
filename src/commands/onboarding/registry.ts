import { listChannelSetupPlugins } from "../../channels/plugins/setup-registry.js";
import { buildChannelOnboardingAdapterFromSetupWizard } from "../../channels/plugins/setup-wizard.js";
import type { ChannelPlugin } from "../../channels/plugins/types.js";
import type { ChannelChoice } from "../onboard-types.js";
import type { ChannelOnboardingAdapter } from "./types.js";

const setupWizardAdapters = new WeakMap<object, ChannelOnboardingAdapter>();

export function resolveChannelOnboardingAdapterForPlugin(
  plugin?: ChannelPlugin,
): ChannelOnboardingAdapter | undefined {
  if (plugin?.setupWizard) {
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
  return undefined;
}

const CHANNEL_ONBOARDING_ADAPTERS = () => {
  const adapters = new Map<ChannelChoice, ChannelOnboardingAdapter>();
  for (const plugin of listChannelSetupPlugins()) {
    const adapter = resolveChannelOnboardingAdapterForPlugin(plugin);
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

export async function loadBundledChannelOnboardingPlugin(
  channel: ChannelChoice,
): Promise<ChannelPlugin | undefined> {
  switch (channel) {
    case "discord":
      return (await import("../../../extensions/discord/setup-entry.js")).default.plugin;
    case "imessage":
      return (await import("../../../extensions/imessage/setup-entry.js")).default.plugin;
    case "signal":
      return (await import("../../../extensions/signal/setup-entry.js")).default.plugin;
    case "slack":
      return (await import("../../../extensions/slack/setup-entry.js")).default.plugin;
    case "telegram":
      return (await import("../../../extensions/telegram/setup-entry.js")).default.plugin;
    case "whatsapp":
      return (await import("../../../extensions/whatsapp/setup-entry.js")).default.plugin;
    default:
      return undefined;
  }
}

// Legacy aliases (pre-rename).
export const getProviderOnboardingAdapter = getChannelOnboardingAdapter;
export const listProviderOnboardingAdapters = listChannelOnboardingAdapters;
