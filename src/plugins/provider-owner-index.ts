import {
  findNormalizedProviderValue,
  normalizeProviderId,
} from "@openclaw/model-catalog-core/provider-id";
import type { PluginManifestRegistry } from "./manifest-registry.types.js";

export type DeclaredProviderOwnerIndex = ReadonlyMap<string, ReadonlySet<string>>;

type ProviderOwnerManifest = {
  id: string;
  providers: readonly string[];
  setup?: { providers?: readonly { id: string }[] };
};

/** Captures declared receivers independently from plugins triggered by a provider. */
export function buildDeclaredProviderOwnerIndex(
  manifests: readonly ProviderOwnerManifest[],
): DeclaredProviderOwnerIndex {
  const winners = new Map<string, ProviderOwnerManifest>();
  for (const plugin of manifests) {
    if (!winners.has(plugin.id)) {
      winners.set(plugin.id, plugin);
    }
  }
  const owners = new Map<string, Set<string>>();
  for (const phase of ["runtime", "setup"] as const) {
    const runtimeRefs = new Set(owners.keys());
    for (const plugin of winners.values()) {
      const refs =
        phase === "runtime"
          ? plugin.providers
          : (plugin.setup?.providers?.map((entry) => entry.id) ?? []);
      for (const ref of refs) {
        const normalized = normalizeProviderId(ref);
        if (phase === "setup" && runtimeRefs.has(normalized)) {
          continue;
        }
        const ids = owners.get(normalized) ?? new Set<string>();
        ids.add(plugin.id);
        owners.set(normalized, ids);
      }
    }
  }
  return owners;
}

export function matchesDeclaredProviderOwner(
  owners: DeclaredProviderOwnerIndex | undefined,
  provider: string,
  pluginId: string,
): boolean {
  return owners?.get(normalizeProviderId(provider))?.has(pluginId) ?? true;
}

type ProviderOwnerIndex = {
  authScopes: ReadonlyMap<string, "agent" | "plugin" | "conflict">;
  providers: ReadonlyMap<string, readonly string[]>;
  refs: ReadonlyMap<string, readonly string[]>;
};

// Reloads and narrowed views publish new registries; retained generations keep
// their own facts, and retiring a registry releases its index with it.
const providerOwnerIndexes = new WeakMap<PluginManifestRegistry, ProviderOwnerIndex>();

export function getProviderOwnerIndex(registry: PluginManifestRegistry): ProviderOwnerIndex {
  const cached = providerOwnerIndexes.get(registry);
  if (cached) {
    return cached;
  }
  const authScopes = new Map<string, "agent" | "plugin" | "conflict">();
  const seen = new Set<string>();
  const providers = new Map<string, string[]>();
  const cliBackends = new Map<string, string[]>();
  const append = (map: Map<string, string[]>, ref: string, pluginId: string) => {
    const ids = map.get(ref);
    if (ids) {
      if (!ids.includes(pluginId)) {
        ids.push(pluginId);
      }
    } else {
      map.set(ref, [pluginId]);
    }
  };
  for (const plugin of registry.plugins) {
    const declared = new Set(plugin.providers.map(normalizeProviderId));
    const firstDeclaration = !seen.has(plugin.id);
    seen.add(plugin.id);
    const appendScope = (ref: string, target: string) => {
      if (!firstDeclaration) {
        return;
      }
      const scope =
        findNormalizedProviderValue(plugin.modelCatalog?.providers, target)?.authScope ?? "agent";
      const previous = authScopes.get(ref);
      authScopes.set(ref, previous && previous !== scope ? "conflict" : scope);
    };
    for (const ref of declared) {
      append(providers, ref, plugin.id);
      appendScope(ref, ref);
    }
    const appendAlias = (alias: string, target: string) => {
      const receiver = normalizeProviderId(target);
      if (receiver && declared.has(receiver)) {
        const normalizedAlias = normalizeProviderId(alias);
        append(providers, normalizedAlias, plugin.id);
        appendScope(normalizedAlias, receiver);
      }
    };
    for (const [alias, target] of Object.entries(plugin.providerAuthAliases ?? {})) {
      if (typeof target === "string") {
        appendAlias(alias, target);
      }
    }
    for (const [alias, target] of Object.entries(plugin.modelCatalog?.aliases ?? {})) {
      appendAlias(alias, target.provider);
    }
    for (const ref of [...plugin.cliBackends, ...(plugin.setup?.cliBackends ?? [])]) {
      append(cliBackends, normalizeProviderId(ref), plugin.id);
    }
  }
  for (const map of [providers, cliBackends]) {
    for (const [ref, ids] of map) {
      const sorted = ids.toSorted((a, b) => a.localeCompare(b));
      Object.freeze(sorted);
      map.set(ref, sorted);
    }
  }
  const index = { authScopes, providers, refs: new Map([...cliBackends, ...providers]) };
  providerOwnerIndexes.set(registry, index);
  return index;
}
