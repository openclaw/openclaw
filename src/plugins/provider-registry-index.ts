import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";

type ProviderIndexEntry = {
  provider: { id: string; aliases?: readonly string[]; hookAliases?: readonly string[] };
};

type ProviderIndex = {
  ids: Map<string, number[]>;
  refs: Map<string, number[]>;
};

// Source and bundled readers share invalidation; each collection is one registry generation.
const indexes = resolveGlobalSingleton(
  Symbol.for("openclaw.providerRegistryIndexes"),
  () => new WeakMap<readonly ProviderIndexEntry[], ProviderIndex>(),
);

/** Registration, contribution copying, and rollback invalidate the mutated collection. */
export function invalidateProviderRegistryIndex(providers: readonly ProviderIndexEntry[]) {
  indexes.delete(providers);
}

function append(index: Map<string, number[]>, ref: string, position: number): void {
  if (!ref) {
    return;
  }
  const entries = index.get(ref);
  if (entries) {
    // Rows arrive in registry order; aliases for this row need only one position.
    if (entries[entries.length - 1] !== position) {
      entries.push(position);
    }
  } else {
    index.set(ref, [position]);
  }
}

/** Candidate facts are cached; eligibility remains a decision of the current caller. */
export function getProviderRegistryIndex(providers: readonly ProviderIndexEntry[]): ProviderIndex {
  let index = indexes.get(providers);
  if (!index) {
    index = { ids: new Map(), refs: new Map() };
    for (const [position, { provider }] of providers.entries()) {
      const id = normalizeProviderId(provider.id);
      append(index.ids, id, position);
      append(index.refs, id, position);
      for (const alias of provider.aliases ?? []) {
        append(index.refs, normalizeProviderId(alias), position);
      }
      for (const alias of provider.hookAliases ?? []) {
        append(index.refs, normalizeProviderId(alias), position);
      }
    }
    indexes.set(providers, index);
  }
  return index;
}
