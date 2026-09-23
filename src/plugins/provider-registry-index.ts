import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import type { PluginProviderRegistration } from "./provider-plugin.types.js";

type ProviderIndex = {
  ids: Map<string, number[]>;
  refs: Map<string, number[]>;
};

// Source and bundled readers share invalidation; each collection is one registry generation.
const indexes = resolveGlobalSingleton(
  Symbol.for("openclaw.providerRegistryIndexes"),
  () => new WeakMap<readonly PluginProviderRegistration[], ProviderIndex>(),
);

/** Registration, contribution copying, and rollback invalidate the mutated collection. */
export function invalidateProviderRegistryIndex(providers: readonly PluginProviderRegistration[]) {
  indexes.delete(providers);
}

function append(index: Map<string, number[]>, ref: string, position: number): void {
  if (!ref) {
    return;
  }
  const entries = index.get(ref);
  if (entries) {
    entries.push(position);
  } else {
    index.set(ref, [position]);
  }
}

/** Candidate facts are cached; eligibility remains a decision of the current caller. */
export function getProviderRegistryIndex(
  providers: readonly PluginProviderRegistration[],
): ProviderIndex {
  let index = indexes.get(providers);
  if (!index) {
    index = { ids: new Map(), refs: new Map() };
    for (const [position, { provider }] of providers.entries()) {
      const id = normalizeProviderId(provider.id);
      append(index.ids, id, position);
      const refs = new Set(
        [provider.id, ...(provider.aliases ?? []), ...(provider.hookAliases ?? [])].map(
          normalizeProviderId,
        ),
      );
      for (const ref of refs) {
        append(index.refs, ref, position);
      }
    }
    indexes.set(providers, index);
  }
  return index;
}
