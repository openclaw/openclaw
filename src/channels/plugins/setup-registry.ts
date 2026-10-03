import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  getActivePluginChannelRegistry,
  requireActivePluginRegistry,
} from "../../plugins/runtime.js";
import { listBundledChannelSetupPlugins } from "./bundled.js";
import { compareChannelPlugins } from "./registry-loaded.js";
import type { AnyChannelPlugin as ChannelPlugin } from "./types.plugin.js";
import type { ChannelId } from "./types.public.js";

function sortChannelSetupPlugins(plugins: readonly ChannelPlugin[]): ChannelPlugin[] {
  const seen = new Set<string>();
  const resolved: ChannelPlugin[] = [];
  for (const plugin of plugins) {
    const id = normalizeOptionalString(plugin.id) ?? "";
    if (!id || seen.has(id)) {
      continue;
    }
    seen.add(id);
    resolved.push(plugin);
  }
  return resolved.toSorted(compareChannelPlugins);
}

export function listChannelSetupPlugins(): ChannelPlugin[] {
  const registry = requireActivePluginRegistry();

  const registryPlugins = (registry.channelSetups ?? []).map((entry) => entry.plugin);
  // Before the registry has setup plugins, bundled setup plugins provide the
  // onboarding catalog so first-run setup can still render.
  return sortChannelSetupPlugins(
    registryPlugins.length > 0 ? registryPlugins : listBundledChannelSetupPlugins(),
  );
}

/**
 * Lists setup plugins from the active channel registry only.
 */
export function listActiveChannelSetupPlugins(): ChannelPlugin[] {
  const registry = getActivePluginChannelRegistry();
  return sortChannelSetupPlugins((registry?.channelSetups ?? []).map((entry) => entry.plugin));
}

/**
 * Returns one setup-capable channel plugin by id.
 */
export function getChannelSetupPlugin(id: ChannelId): ChannelPlugin | undefined {
  const resolvedId = normalizeOptionalString(id) ?? "";
  if (!resolvedId) {
    return undefined;
  }
  return listChannelSetupPlugins().find((plugin) => plugin.id === resolvedId);
}
