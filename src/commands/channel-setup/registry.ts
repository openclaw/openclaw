import { listChannelSetupPlugins } from "../../channels/plugins/setup-registry.js";
import { buildChannelSetupWizardAdapterFromSetupWizard } from "../../channels/plugins/setup-wizard.js";
import type { ChannelSetupWizard } from "../../channels/plugins/setup-wizard.js";
import type { ChannelPlugin } from "../../channels/plugins/types.plugin.js";
import type { ChannelChoice } from "../onboard-types.js";
import type { ChannelSetupWizardAdapter } from "./types.js";

const setupWizardAdapters = new WeakMap<object, ChannelSetupWizardAdapter>();

function isChannelSetupWizardAdapter(
  setupWizard: ChannelPlugin["setupWizard"],
): setupWizard is ChannelSetupWizardAdapter {
  return Boolean(
    setupWizard &&
    typeof setupWizard === "object" &&
    "getStatus" in setupWizard &&
    typeof setupWizard.getStatus === "function" &&
    "configure" in setupWizard &&
    typeof setupWizard.configure === "function",
  );
}

function isDeclarativeChannelSetupWizard(
  setupWizard: ChannelPlugin["setupWizard"],
): setupWizard is ChannelSetupWizard {
  return Boolean(
    setupWizard &&
    typeof setupWizard === "object" &&
    "status" in setupWizard &&
    "credentials" in setupWizard,
  );
}

/** Resolves either an imperative setup adapter or a cached adapter for a declarative channel wizard. */
export function resolveChannelSetupWizardAdapterForPlugin(
  plugin?: ChannelPlugin,
): ChannelSetupWizardAdapter | undefined {
  if (!plugin) {
    return undefined;
  }
  const { setupWizard } = plugin;
  if (isChannelSetupWizardAdapter(setupWizard)) {
    return setupWizard;
  }
  if (isDeclarativeChannelSetupWizard(setupWizard)) {
    const cached = setupWizardAdapters.get(plugin);
    if (cached) {
      return cached;
    }
    // Declarative wizards are wrapped once per plugin object so repeated setup prompts share adapter state.
    const adapter = buildChannelSetupWizardAdapterFromSetupWizard({
      plugin,
      wizard: setupWizard,
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

/** Looks up the setup wizard adapter for a channel from the current channel plugin registry snapshot. */
export function getChannelSetupWizardAdapter(
  channel: ChannelChoice,
): ChannelSetupWizardAdapter | undefined {
  return getChannelSetupWizardAdapterMap().get(channel);
}
