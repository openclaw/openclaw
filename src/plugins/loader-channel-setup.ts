import { mergeChannelPluginSection } from "../channels/plugins/merge-plugin-section.js";
import type { AnyChannelPlugin as ChannelPlugin } from "../channels/plugins/types.plugin.js";
import { isChannelConfigured } from "../config/channel-configured.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ChannelPluginLoadIntent } from "./loader-types.js";
import { unwrapDefaultModuleExport } from "./module-export.js";
import type { PluginRuntime } from "./runtime/types.js";
import type { OpenClawPluginApi } from "./types.js";

export function mergeSetupRuntimeChannelPlugin(
  runtimePlugin: ChannelPlugin,
  setupPlugin: ChannelPlugin,
): ChannelPlugin {
  return {
    ...runtimePlugin,
    ...setupPlugin,
    meta: mergeChannelPluginSection(runtimePlugin.meta, setupPlugin.meta),
    capabilities: mergeChannelPluginSection(runtimePlugin.capabilities, setupPlugin.capabilities),
    commands: mergeChannelPluginSection(runtimePlugin.commands, setupPlugin.commands),
    doctor: mergeChannelPluginSection(runtimePlugin.doctor, setupPlugin.doctor),
    reload: mergeChannelPluginSection(runtimePlugin.reload, setupPlugin.reload),
    config: mergeChannelPluginSection(runtimePlugin.config, setupPlugin.config),
    setup: mergeChannelPluginSection(runtimePlugin.setup, setupPlugin.setup),
    messaging: mergeChannelPluginSection(runtimePlugin.messaging, setupPlugin.messaging),
    actions: mergeChannelPluginSection(runtimePlugin.actions, setupPlugin.actions),
    secrets: mergeChannelPluginSection(runtimePlugin.secrets, setupPlugin.secrets),
  } as ChannelPlugin;
}

type BundledRuntimeChannelRegistration = {
  id?: string;
  loadChannelPlugin?: () => ChannelPlugin;
  loadChannelSecrets?: () => ChannelPlugin["secrets"] | undefined;
  setChannelRuntime?: (runtime: PluginRuntime) => void;
};

function mergeLoadedChannelSecrets(
  loaded: unknown,
  secrets: ChannelPlugin["secrets"],
): ChannelPlugin | undefined {
  if (!loaded || typeof loaded !== "object") {
    return undefined;
  }
  const plugin = loaded as ChannelPlugin;
  const mergedSecrets = mergeChannelPluginSection(plugin.secrets, secrets);
  return {
    ...plugin,
    ...(mergedSecrets !== undefined ? { secrets: mergedSecrets } : {}),
  };
}

export function resolveBundledRuntimeChannelRegistration(
  moduleExport: unknown,
): BundledRuntimeChannelRegistration {
  const resolved = unwrapDefaultModuleExport(moduleExport);
  if (!resolved || typeof resolved !== "object") {
    return {};
  }
  const entryRecord = resolved as {
    kind?: unknown;
    id?: unknown;
    loadChannelPlugin?: unknown;
    loadChannelSecrets?: unknown;
    setChannelRuntime?: unknown;
  };
  if (
    entryRecord.kind !== "bundled-channel-entry" ||
    typeof entryRecord.id !== "string" ||
    typeof entryRecord.loadChannelPlugin !== "function"
  ) {
    return {};
  }
  return {
    id: entryRecord.id,
    loadChannelPlugin: entryRecord.loadChannelPlugin as () => ChannelPlugin,
    ...(typeof entryRecord.loadChannelSecrets === "function"
      ? {
          loadChannelSecrets: entryRecord.loadChannelSecrets as () =>
            | ChannelPlugin["secrets"]
            | undefined,
        }
      : {}),
    ...(typeof entryRecord.setChannelRuntime === "function"
      ? {
          setChannelRuntime: entryRecord.setChannelRuntime as (runtime: PluginRuntime) => void,
        }
      : {}),
  };
}

export function loadBundledRuntimeChannelPlugin(params: {
  registration: BundledRuntimeChannelRegistration;
}): {
  plugin?: ChannelPlugin;
  loadError?: unknown;
} {
  if (typeof params.registration.loadChannelPlugin !== "function") {
    return {};
  }
  try {
    const plugin = mergeLoadedChannelSecrets(
      params.registration.loadChannelPlugin(),
      params.registration.loadChannelSecrets?.(),
    );
    return plugin ? { plugin } : {};
  } catch (err) {
    return { loadError: err };
  }
}

export function resolveSetupChannelRegistration(moduleExport: unknown): {
  plugin?: ChannelPlugin;
  setChannelRuntime?: (runtime: PluginRuntime) => void;
  registerSetupRuntime?: (api: OpenClawPluginApi) => void;
  usesBundledSetupContract?: boolean;
  loadError?: unknown;
} {
  const resolved = unwrapDefaultModuleExport(moduleExport);
  if (!resolved || typeof resolved !== "object") {
    return {};
  }
  const setupEntryRecord = resolved as {
    plugin?: unknown;
    kind?: unknown;
    loadSetupPlugin?: unknown;
    loadSetupSecrets?: unknown;
    setChannelRuntime?: unknown;
    registerSetupRuntime?: unknown;
  };
  if (
    setupEntryRecord.kind === "bundled-channel-setup-entry" &&
    typeof setupEntryRecord.loadSetupPlugin === "function"
  ) {
    try {
      const plugin = mergeLoadedChannelSecrets(
        setupEntryRecord.loadSetupPlugin(),
        typeof setupEntryRecord.loadSetupSecrets === "function"
          ? (setupEntryRecord.loadSetupSecrets() as ChannelPlugin["secrets"] | undefined)
          : undefined,
      );
      if (plugin) {
        return {
          plugin,
          usesBundledSetupContract: true,
          ...(typeof setupEntryRecord.setChannelRuntime === "function"
            ? {
                setChannelRuntime: setupEntryRecord.setChannelRuntime as (
                  runtime: PluginRuntime,
                ) => void,
              }
            : {}),
          ...(typeof setupEntryRecord.registerSetupRuntime === "function"
            ? {
                registerSetupRuntime: setupEntryRecord.registerSetupRuntime as (
                  api: OpenClawPluginApi,
                ) => void,
              }
            : {}),
        };
      }
    } catch (err) {
      return { loadError: err };
    }
  }
  if (!setupEntryRecord.plugin || typeof setupEntryRecord.plugin !== "object") {
    return {};
  }
  return {
    plugin: setupEntryRecord.plugin as ChannelPlugin,
    ...(typeof setupEntryRecord.setChannelRuntime === "function"
      ? {
          setChannelRuntime: setupEntryRecord.setChannelRuntime as (runtime: PluginRuntime) => void,
        }
      : {}),
  };
}

export function shouldLoadChannelPluginInSetupRuntime(params: {
  manifestChannels: string[];
  setupSource?: string;
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  channelPluginLoadIntent: ChannelPluginLoadIntent;
}): boolean {
  if (
    params.channelPluginLoadIntent !== "setup" ||
    !params.setupSource ||
    params.manifestChannels.length === 0
  ) {
    return false;
  }
  return !params.manifestChannels.some((channelId) =>
    isChannelConfigured(params.cfg, channelId, params.env),
  );
}

export function channelPluginIdBelongsToManifest(params: {
  channelId: string | undefined;
  pluginId: string;
  manifestChannels: readonly string[];
}): boolean {
  if (!params.channelId) {
    return true;
  }
  return params.channelId === params.pluginId || params.manifestChannels.includes(params.channelId);
}
