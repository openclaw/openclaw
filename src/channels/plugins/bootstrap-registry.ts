import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  getBundledChannelPlugin,
  getBundledChannelSecrets,
  getBundledChannelSetupPlugin,
  getBundledChannelSetupSecrets,
} from "./bundled.js";
import { mergeChannelPlugins, mergeChannelPluginSection } from "./merge-plugin-section.js";
import type { AnyChannelPlugin as ChannelPlugin } from "./types.plugin.js";
import type { ChannelId } from "./types.public.js";

/**
 * Loads a bundled channel plugin for bootstrap, merging runtime and setup artifacts.
 */
export function getBootstrapChannelPlugin(id: ChannelId): ChannelPlugin | undefined {
  const resolvedId = normalizeOptionalString(id);
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
  return runtimePlugin && setupPlugin
    ? mergeChannelPlugins(runtimePlugin, setupPlugin, "override")
    : (setupPlugin ?? runtimePlugin);
}

/**
 * Loads bootstrap secret metadata from bundled runtime and setup artifacts.
 */
export function getBootstrapChannelSecrets(id: ChannelId): ChannelPlugin["secrets"] | undefined {
  const resolvedId = normalizeOptionalString(id);
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
