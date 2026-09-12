// Plugin and hook-pack update selectors for id and npm-spec command inputs.
import type { HookInstallRecord } from "../config/types.hooks.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { parseRegistryNpmSpec } from "../infra/npm-registry-spec.js";

function installedNpmPackageName(
  install: Pick<PluginInstallRecord, "resolvedName" | "spec" | "resolvedSpec">,
): string | undefined {
  return (
    install.resolvedName?.trim() ||
    ((install.spec ? parseRegistryNpmSpec(install.spec)?.name : undefined) ??
      (install.resolvedSpec ? parseRegistryNpmSpec(install.resolvedSpec)?.name : undefined))
  );
}

function resolveTrackedUpdateSelection<T>(params: {
  installs: Record<string, T>;
  rawId?: string;
  all?: boolean;
  packageName: (install: T) => string | undefined;
}): { ids: string[]; specOverrides?: Record<string, string> } {
  if (params.all) {
    return { ids: Object.keys(params.installs) };
  }
  if (!params.rawId) {
    return { ids: [] };
  }
  if (Object.hasOwn(params.installs, params.rawId)) {
    return { ids: [params.rawId] };
  }
  const spec = parseRegistryNpmSpec(params.rawId);
  const matches = spec
    ? Object.entries(params.installs).filter(
        ([, install]) => params.packageName(install) === spec.name,
      )
    : [];
  const match = matches.length === 1 ? matches[0] : undefined;
  if (!spec || !match?.[0]) {
    return { ids: [] };
  }
  return { ids: [match[0]], specOverrides: { [match[0]]: spec.raw } };
}

/** Resolve a plugin update target and optional npm spec override from CLI input. */
export function resolvePluginUpdateSelection(params: {
  installs: Record<string, PluginInstallRecord>;
  installOwnerByPluginId?: ReadonlyMap<string, string>;
  rejectedPluginIds?: ReadonlyMap<string, string>;
  rawId?: string;
  all?: boolean;
}): { pluginIds: string[]; specOverrides?: Record<string, string>; error?: string } {
  if (!params.all && params.rawId) {
    if (params.rejectedPluginIds?.has(params.rawId)) {
      return { pluginIds: [], error: params.rejectedPluginIds.get(params.rawId) };
    }
    const owner = params.installOwnerByPluginId?.get(params.rawId);
    if (
      !Object.hasOwn(params.installs, params.rawId) &&
      owner &&
      Object.hasOwn(params.installs, owner)
    ) {
      return { pluginIds: [owner] };
    }
  }
  const { ids, ...selection } = resolveTrackedUpdateSelection({
    ...params,
    packageName: (install) =>
      install.source === "npm" ? installedNpmPackageName(install) : undefined,
  });
  const rejectedId = ids.find((id) => params.rejectedPluginIds?.has(id));
  return rejectedId === undefined
    ? { pluginIds: ids, ...selection }
    : { pluginIds: [], error: params.rejectedPluginIds?.get(rejectedId) };
}

/** Resolve a hook-pack update target and optional npm spec override from CLI input. */
export function resolveHookPackUpdateSelection(params: {
  installs: Record<string, HookInstallRecord>;
  rawId?: string;
  all?: boolean;
}): { hookIds: string[]; specOverrides?: Record<string, string> } {
  const { ids, ...selection } = resolveTrackedUpdateSelection({
    ...params,
    packageName: installedNpmPackageName,
  });
  return { hookIds: ids, ...selection };
}
