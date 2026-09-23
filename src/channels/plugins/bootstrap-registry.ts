/**
 * Bundled channel bootstrap registry.
 *
 * Provides channel plugin metadata before the full runtime registry is installed.
 */
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  getBundledChannelPlugin,
  getBundledChannelSecrets,
  getBundledChannelSetupPlugin,
  getBundledChannelSetupSecrets,
} from "./bundled.js";
import { mergeChannelPluginSection } from "./merge-plugin-section.js";
import type { ChannelPlugin } from "./types.plugin.js";
import type { ChannelId } from "./types.public.js";

function resolveBootstrapChannelId(id: ChannelId): string {
  return normalizeOptionalString(id) ?? "";
}

function mergeBootstrapPlugin(
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
    messaging: mergeChannelPluginSection(runtimePlugin.messaging, setupPlugin.messaging),
    actions: mergeChannelPluginSection(runtimePlugin.actions, setupPlugin.actions),
    secrets: mergeChannelPluginSection(runtimePlugin.secrets, setupPlugin.secrets),
  } as ChannelPlugin;
}

/**
 * Loads a bundled channel plugin for bootstrap, merging runtime and setup artifacts.
 */
export function getBootstrapChannelPlugin(id: ChannelId): ChannelPlugin | undefined {
  const resolvedId = resolveBootstrapChannelId(id);
  if (!resolvedId) {
    return undefined;
  }
  let runtimePlugin: ChannelPlugin | undefined;
  let setupPlugin: ChannelPlugin | undefined;
  try {
    runtimePlugin = getBundledChannelPlugin(resolvedId);
    setupPlugin = getBundledChannelSetupPlugin(resolvedId);
  } catch {
    // Bootstrap discovery treats broken/missing bundled channel artifacts as
    // absent so install/doctor flows can continue scanning other channels.
    return undefined;
  }
  const merged =
    runtimePlugin && setupPlugin
      ? mergeBootstrapPlugin(runtimePlugin, setupPlugin)
      : (setupPlugin ?? runtimePlugin);
  return merged;
}

/**
 * Loads bootstrap secret metadata from bundled runtime and setup artifacts.
 */
export function getBootstrapChannelSecrets(id: ChannelId): ChannelPlugin["secrets"] | undefined {
  const resolvedId = resolveBootstrapChannelId(id);
  if (!resolvedId) {
    return undefined;
  }
  try {
    const runtimeSecrets = getBundledChannelSecrets(resolvedId);
    const setupSecrets = getBundledChannelSetupSecrets(resolvedId);
    return mergeChannelPluginSection(runtimeSecrets, setupSecrets);
  } catch {
    return undefined;
  }
}
