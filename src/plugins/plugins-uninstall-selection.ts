import type { OpenClawConfig } from "../config/types.openclaw.js";
import { parseClawHubPluginSpec } from "../infra/clawhub-spec.js";
import type { PluginRecord } from "./registry.js";

export function resolvePluginUninstallId<
  TPlugin extends Pick<PluginRecord, "id" | "name">,
>(params: {
  rawId: string;
  config: OpenClawConfig;
  plugins: TPlugin[];
}): { pluginId: string; plugin?: TPlugin } {
  const rawId = params.rawId.trim();
  const selectionFor = (pluginId: string): { pluginId: string; plugin?: TPlugin } => {
    const selectedPlugin = params.plugins.find((entry) => entry.id === pluginId);
    return selectedPlugin ? { pluginId, plugin: selectedPlugin } : { pluginId };
  };
  const plugin = params.plugins.find((entry) => entry.id === rawId || entry.name === rawId);
  if (plugin) {
    return { pluginId: plugin.id, plugin };
  }

  for (const [pluginId, install] of Object.entries(params.config.plugins?.installs ?? {})) {
    if (
      install.spec === rawId ||
      install.resolvedSpec === rawId ||
      install.resolvedName === rawId ||
      install.marketplacePlugin === rawId
    ) {
      return selectionFor(pluginId);
    }
  }

  const requestedClawHub = parseClawHubPluginSpec(rawId);
  if (requestedClawHub) {
    for (const [pluginId, install] of Object.entries(params.config.plugins?.installs ?? {})) {
      const installedClawHubName =
        install.clawhubPackage ??
        parseClawHubPluginSpec(install.spec ?? "")?.name ??
        parseClawHubPluginSpec(install.resolvedSpec ?? "")?.name;
      if (installedClawHubName === requestedClawHub.name) {
        return selectionFor(pluginId);
      }
    }
  }

  return { pluginId: rawId };
}
