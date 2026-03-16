import { listChannelPlugins } from "../../channels/plugins/index.js";
import { imessageOnboardingAdapter } from "../../channels/plugins/onboarding/imessage.js";
import { signalOnboardingAdapter } from "../../channels/plugins/onboarding/signal.js";
import { telegramOnboardingAdapter } from "../../channels/plugins/onboarding/telegram.js";
import { whatsappOnboardingAdapter } from "../../channels/plugins/onboarding/whatsapp.js";
import type { ChannelChoice } from "../onboard-types.js";
import type { ChannelOnboardingAdapter } from "./types.js";

// Keep built-ins limited to core adapters that do not depend on extension-only entrypoints.
// Extension-backed adapters (e.g. discord/slack) are loaded via the plugin registry.
const BUILTIN_ONBOARDING_ADAPTERS: ChannelOnboardingAdapter[] = [
  telegramOnboardingAdapter,
  whatsappOnboardingAdapter,
  signalOnboardingAdapter,
  imessageOnboardingAdapter,
];

const CHANNEL_ONBOARDING_ADAPTERS = () => {
  const fromRegistry = listChannelPlugins()
    .map((plugin) => (plugin.onboarding ? ([plugin.id, plugin.onboarding] as const) : null))
    .filter((entry): entry is readonly [ChannelChoice, ChannelOnboardingAdapter] => Boolean(entry));

  // Fall back to built-in adapters to keep onboarding working even when the plugin registry
  // fails to populate (see #25545).
  const fromBuiltins = BUILTIN_ONBOARDING_ADAPTERS.map(
    (adapter) => [adapter.channel, adapter] as const,
  );

  return new Map<ChannelChoice, ChannelOnboardingAdapter>([...fromBuiltins, ...fromRegistry]);
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
