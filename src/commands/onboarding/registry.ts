import { discordPlugin } from "../../../extensions/discord/src/channel.js";
import { imessagePlugin } from "../../../extensions/imessage/src/channel.js";
import { signalPlugin } from "../../../extensions/signal/src/channel.js";
import { slackPlugin } from "../../../extensions/slack/src/channel.js";
import { telegramPlugin } from "../../../extensions/telegram/src/channel.js";
import { whatsappPlugin } from "../../../extensions/whatsapp/src/channel.js";
import { listChannelSetupPlugins } from "../../channels/plugins/setup-registry.js";
import { buildChannelOnboardingAdapterFromSetupWizard } from "../../channels/plugins/setup-wizard.js";
import type { ChannelChoice } from "../onboard-types.js";
import type { ChannelOnboardingAdapter } from "./types.js";

const telegramOnboardingAdapter = buildChannelOnboardingAdapterFromSetupWizard({
  plugin: telegramPlugin,
  wizard: telegramPlugin.setupWizard!,
});
const discordOnboardingAdapter = buildChannelOnboardingAdapterFromSetupWizard({
  plugin: discordPlugin,
  wizard: discordPlugin.setupWizard!,
});
const slackOnboardingAdapter = buildChannelOnboardingAdapterFromSetupWizard({
  plugin: slackPlugin,
  wizard: slackPlugin.setupWizard!,
});
const signalOnboardingAdapter = buildChannelOnboardingAdapterFromSetupWizard({
  plugin: signalPlugin,
  wizard: signalPlugin.setupWizard!,
});
const imessageOnboardingAdapter = buildChannelOnboardingAdapterFromSetupWizard({
  plugin: imessagePlugin,
  wizard: imessagePlugin.setupWizard!,
});
const whatsappOnboardingAdapter = buildChannelOnboardingAdapterFromSetupWizard({
  plugin: whatsappPlugin,
  wizard: whatsappPlugin.setupWizard!,
});

const BUILTIN_ONBOARDING_ADAPTERS: ChannelOnboardingAdapter[] = [
  telegramOnboardingAdapter,
  whatsappOnboardingAdapter,
  discordOnboardingAdapter,
  slackOnboardingAdapter,
  signalOnboardingAdapter,
  imessageOnboardingAdapter,
];

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
  return undefined;
}

const CHANNEL_ONBOARDING_ADAPTERS = () => {
  const adapters = new Map<ChannelChoice, ChannelOnboardingAdapter>(
    BUILTIN_ONBOARDING_ADAPTERS.map((adapter) => [adapter.channel, adapter] as const),
  );
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
