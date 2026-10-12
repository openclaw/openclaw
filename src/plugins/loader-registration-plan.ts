import type { OpenClawConfig } from "../config/types.openclaw.js";
import { shouldLoadChannelPluginInSetupRuntime } from "./loader-channel-setup.js";
import type { ChannelPluginLoadIntent } from "./loader-types.js";
import type { PluginManifestRecord } from "./manifest-registry.js";
import type { PluginRegistrationMode } from "./types.js";

export type PluginRegistrationPlan = ReturnType<typeof createRegistrationPlan>;

function createRegistrationPlan(mode: PluginRegistrationMode) {
  const loadSetupEntry = mode === "setup-only" || mode === "setup-runtime";
  return {
    /** Public compatibility label passed to plugin register(api). */
    mode,
    /** Load a setup entry instead of the normal runtime entry. */
    loadSetupEntry,
    /** Setup flow also needs the runtime channel entry for runtime setters/plugin shape. */
    loadSetupRuntimeEntry: mode === "setup-runtime",
    /** Apply runtime capability policy such as memory-slot selection. */
    runRuntimeCapabilityPolicy: !loadSetupEntry,
    /** Register metadata that only belongs to live activation. */
    runFullActivationOnlyRegistrations: mode === "full",
  };
}

/** Converts loader intent into explicit entrypoint and activation behavior. */
export function resolvePluginRegistrationPlan(params: {
  canLoadScopedSetupOnlyChannelPlugin: boolean;
  enableStateEnabled: boolean;
  shouldLoadModules: boolean;
  validateOnly: boolean;
  runtimeSideEffects: boolean;
  manifestRecord: PluginManifestRecord;
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  channelPluginLoadIntent: ChannelPluginLoadIntent;
  toolDiscovery: boolean;
  cliMetadata?: boolean;
}): PluginRegistrationPlan | null {
  if (params.cliMetadata) {
    return params.enableStateEnabled ? createRegistrationPlan("cli-metadata") : null;
  }
  if (params.canLoadScopedSetupOnlyChannelPlugin) {
    return createRegistrationPlan("setup-only");
  }
  if (!params.enableStateEnabled) {
    return null;
  }
  if (params.toolDiscovery) {
    return createRegistrationPlan("tool-discovery");
  }
  const loadSetupRuntimeEntry =
    params.shouldLoadModules &&
    !params.validateOnly &&
    shouldLoadChannelPluginInSetupRuntime({
      manifestChannels: params.manifestRecord.channels,
      setupSource: params.manifestRecord.setupSource,
      cfg: params.cfg,
      env: params.env,
      channelPluginLoadIntent: params.channelPluginLoadIntent,
    });
  if (loadSetupRuntimeEntry) {
    return createRegistrationPlan("setup-runtime");
  }
  return createRegistrationPlan(params.runtimeSideEffects ? "full" : "discovery");
}
