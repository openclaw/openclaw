<<<<<<< HEAD
import type { ChannelSetupWizardAdapter } from "../../channels/plugins/setup-wizard-types.js";
// Adapts declarative and imperative channel setup wizards to the command-facing interface.
import { buildChannelSetupWizardAdapterFromSetupWizard } from "../../channels/plugins/setup-wizard.js";
import type { ChannelSetupWizard } from "../../channels/plugins/setup-wizard.js";
import type { ChannelPlugin } from "../../channels/plugins/types.plugin.js";
=======
// Adapts declarative and imperative channel setup wizards to the command-facing interface.
import { listChannelSetupPlugins } from "../../channels/plugins/setup-registry.js";
import { buildChannelSetupWizardAdapterFromSetupWizard } from "../../channels/plugins/setup-wizard.js";
import type { ChannelSetupWizard } from "../../channels/plugins/setup-wizard.js";
import type { ChannelPlugin } from "../../channels/plugins/types.plugin.js";
import type { ChannelChoice } from "../onboard-types.js";
import type { ChannelSetupWizardAdapter } from "./types.js";
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df

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

/** Resolve the setup wizard adapter exposed by one channel plugin, caching declarative adapters. */
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
    const adapter = buildChannelSetupWizardAdapterFromSetupWizard({
      plugin,
      wizard: setupWizard,
    });
    setupWizardAdapters.set(plugin, adapter);
    return adapter;
  }
  return undefined;
}
<<<<<<< HEAD
=======

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

/** Look up the setup wizard adapter for a registered setup channel. */
export function getChannelSetupWizardAdapter(
  channel: ChannelChoice,
): ChannelSetupWizardAdapter | undefined {
  return getChannelSetupWizardAdapterMap().get(channel);
}
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
