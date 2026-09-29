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

type TrackedUpdateSelection = {
  ids: string[];
  specOverrides?: Record<string, string>;
  unmatchedIds?: string[];
  error?: string;
};

function resolveTrackedUpdateSelection<T>(params: {
  installs: Record<string, T>;
  rawIds: readonly string[];
  all?: boolean;
  packageName: (install: T) => string | undefined;
  installOwnerByPluginId?: ReadonlyMap<string, string>;
  rejectedPluginIds?: ReadonlyMap<string, string>;
}): TrackedUpdateSelection {
  const ids = new Set<string>();
  const overrides = new Map<string, string>();
  const unmatchedIds = new Set<string>();
  for (const rawId of params.all ? Object.keys(params.installs) : params.rawIds) {
    if (params.rejectedPluginIds?.has(rawId)) {
      return { ids: [], error: params.rejectedPluginIds.get(rawId) };
    }
    const owner = params.installOwnerByPluginId?.get(rawId) ?? rawId;
    let id: string | undefined = Object.hasOwn(params.installs, owner) ? owner : undefined;
    let specOverride: string | undefined;
    if (!id) {
      const spec = parseRegistryNpmSpec(rawId);
      const matches = spec
        ? Object.entries(params.installs).filter(
            ([, install]) => params.packageName(install) === spec.name,
          )
        : [];
      const match = matches.length === 1 ? matches[0] : undefined;
      if (match && spec) {
        id = match[0];
        specOverride = spec.raw;
      }
    }
    if (!id) {
      unmatchedIds.add(rawId);
      continue;
    }
    if (params.rejectedPluginIds?.has(id)) {
      return { ids: [], error: params.rejectedPluginIds.get(id) };
    }
    if (specOverride) {
      const previous = overrides.get(id);
      if (previous !== undefined && previous !== specOverride) {
        return {
          ids: [],
          error: `Conflicting npm specs for "${id}": "${previous}" and "${specOverride}". Choose one spec per installed package.`,
        };
      }
      overrides.set(id, specOverride);
    }
    ids.add(id);
  }
  return {
    ids: [...ids],
    ...(overrides.size > 0 ? { specOverrides: Object.fromEntries(overrides) } : {}),
    ...(unmatchedIds.size > 0 ? { unmatchedIds: [...unmatchedIds] } : {}),
  };
}

/** Resolve plugin update targets and npm spec overrides from CLI inputs. */
export function resolvePluginUpdateSelection(params: {
  installs: Record<string, PluginInstallRecord>;
  installOwnerByPluginId?: ReadonlyMap<string, string>;
  rejectedPluginIds?: ReadonlyMap<string, string>;
  rawIds: readonly string[];
  all?: boolean;
}): Omit<TrackedUpdateSelection, "ids"> & { pluginIds: string[] } {
  const { ids, ...selection } = resolveTrackedUpdateSelection({
    ...params,
    packageName: (install) =>
      install.source === "npm" ? installedNpmPackageName(install) : undefined,
  });
  return { pluginIds: ids, ...selection };
}

/** Resolve hook-pack update targets and npm spec overrides from CLI inputs. */
export function resolveHookPackUpdateSelection(params: {
  installs: Record<string, HookInstallRecord>;
  rawIds: readonly string[];
  all?: boolean;
}): Omit<TrackedUpdateSelection, "ids"> & { hookIds: string[] } {
  const { ids, ...selection } = resolveTrackedUpdateSelection({
    ...params,
    packageName: installedNpmPackageName,
  });
  return { hookIds: ids, ...selection };
}
