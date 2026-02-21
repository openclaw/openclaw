import { listChannelPlugins } from "../../channels/plugins/index.js";
import type { ChannelChoice } from "../onboard-types.js";
import type { ChannelOnboardingAdapter } from "./types.js";

/**
 * Build a map of channel onboarding adapters from loaded plugins.
 *
 * A runtime guard (`typeof getStatus === "function"`) is applied because
 * third-party or partially-loaded plugins may expose a truthy `onboarding`
 * object that does not fully conform to the `ChannelOnboardingAdapter`
 * interface, which would cause a `TypeError: adapter.getStatus is not a
 * function` during `collectChannelStatus` / `refreshStatus`.
 */
const CHANNEL_ONBOARDING_ADAPTERS = () =>
  new Map<ChannelChoice, ChannelOnboardingAdapter>(
    listChannelPlugins()
      .map((plugin) =>
        plugin.onboarding && typeof plugin.onboarding.getStatus === "function"
          ? ([plugin.id as ChannelChoice, plugin.onboarding] as const)
          : null,
      )
      .filter((entry): entry is readonly [ChannelChoice, ChannelOnboardingAdapter] =>
        Boolean(entry),
      ),
  );

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
