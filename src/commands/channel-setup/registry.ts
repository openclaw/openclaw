import { discordPlugin } from "../../../extensions/discord/src/channel.js";
import { googlechatPlugin } from "../../../extensions/googlechat/src/channel.js";
import { imessagePlugin } from "../../../extensions/imessage/src/channel.js";
import { ircPlugin } from "../../../extensions/irc/src/channel.js";
import { linePlugin } from "../../../extensions/line/src/channel.js";
import { signalPlugin } from "../../../extensions/signal/src/channel.js";
import { slackPlugin } from "../../../extensions/slack/src/channel.js";
import { telegramPlugin } from "../../../extensions/telegram/src/channel.js";
import { whatsappPlugin } from "../../../extensions/whatsapp/src/channel.js";
import { listChannelSetupPlugins } from "../../channels/plugins/setup-registry.js";
import { buildChannelOnboardingAdapterFromSetupWizard } from "../../channels/plugins/setup-wizard.js";
import type { ChannelPlugin } from "../../channels/plugins/types.js";
import type { ChannelChoice } from "../onboard-types.js";
import type { ChannelOnboardingAdapter } from "../onboarding/types.js";

const EMPTY_REGISTRY_FALLBACK_PLUGINS = [
  telegramPlugin,
  whatsappPlugin,
  discordPlugin,
  ircPlugin,
  googlechatPlugin,
  slackPlugin,
  signalPlugin,
  imessagePlugin,
  linePlugin,
];

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
  const setupPlugins = listChannelSetupPlugins();
  const plugins =
    setupPlugins.length > 0
      ? setupPlugins
      : (EMPTY_REGISTRY_FALLBACK_PLUGINS as unknown as ReturnType<typeof listChannelSetupPlugins>);
  for (const plugin of plugins) {
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
      return discordPlugin as ChannelPlugin;
    case "googlechat":
      return googlechatPlugin as ChannelPlugin;
    case "imessage":
      return imessagePlugin as ChannelPlugin;
    case "irc":
      return ircPlugin as ChannelPlugin;
    case "line":
      return linePlugin as ChannelPlugin;
    case "signal":
      return signalPlugin as ChannelPlugin;
    case "slack":
      return slackPlugin as ChannelPlugin;
    case "telegram":
      return telegramPlugin as ChannelPlugin;
    case "whatsapp":
      return whatsappPlugin as ChannelPlugin;
    default:
      return undefined;
  }
}

// Legacy aliases (pre-rename).
export const getProviderOnboardingAdapter = getChannelOnboardingAdapter;
export const listProviderOnboardingAdapters = listChannelOnboardingAdapters;
