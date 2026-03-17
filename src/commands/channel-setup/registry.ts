import type { ChannelSetupPlugin } from "../../channels/plugins/setup-wizard-types.js";
import {
  getChannelOnboardingAdapter,
  listChannelOnboardingAdapters,
} from "../onboarding/registry.js";
import type { ChannelSetupWizardAdapter } from "./types.js";

export function resolveChannelSetupWizardAdapterForPlugin(
  plugin?: ChannelSetupPlugin,
): ChannelSetupWizardAdapter | undefined {
  if (!plugin) {
    return undefined;
  }
  return plugin.onboarding ?? getChannelOnboardingAdapter(plugin.id);
}

export function listChannelSetupWizardAdapters(): ChannelSetupWizardAdapter[] {
  return listChannelOnboardingAdapters();
}
