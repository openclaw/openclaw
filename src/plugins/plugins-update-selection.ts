import type { PluginInstallRecord } from "../config/types.plugins.js";
import { parseRegistryNpmSpec } from "../infra/npm-registry-spec.js";
import { extractInstalledNpmPackageName } from "./install-records.js";

export function resolvePluginUpdateSelection(params: {
  installs: Record<string, PluginInstallRecord>;
  rawId?: string;
  all?: boolean;
}): { pluginIds: string[]; specOverrides?: Record<string, string> } {
  if (params.all) {
    return { pluginIds: Object.keys(params.installs) };
  }
  if (!params.rawId) {
    return { pluginIds: [] };
  }

  if (params.rawId in params.installs) {
    return { pluginIds: [params.rawId] };
  }

  const parsedSpec = parseRegistryNpmSpec(params.rawId);
  if (!parsedSpec) {
    return { pluginIds: [params.rawId] };
  }
  const matches = Object.entries(params.installs).filter(([, install]) => {
    return extractInstalledNpmPackageName(install) === parsedSpec.name;
  });
  if (matches.length !== 1) {
    return { pluginIds: [params.rawId] };
  }

  const [pluginId] = matches[0];
  if (!pluginId) {
    return { pluginIds: [params.rawId] };
  }
  return {
    pluginIds: [pluginId],
    specOverrides: {
      [pluginId]: parsedSpec.raw,
    },
  };
}
