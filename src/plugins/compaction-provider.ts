/**
 * Compaction provider registry — process-global singleton.
 *
 * Plugins implement the CompactionProvider interface and register via
 * `registerCompactionProvider()`. The compaction safeguard checks this
 * registry before falling back to the built-in `summarizeInStages()`.
 */

// ---------------------------------------------------------------------------
// Provider interface
// ---------------------------------------------------------------------------

/**
 * A pluggable compaction provider that can replace the built-in
 * summarizeInStages pipeline.
 */
export interface CompactionProvider {
  id: string;
  label: string;
  summarize(params: {
    messages: unknown[];
    signal?: AbortSignal;
    compressionRatio?: number;
    /** Summary from a prior compaction round, if re-compacting. */
    previousSummary?: string;
  }): Promise<string>;
}

// ---------------------------------------------------------------------------
// Registry (module-level singleton)
// ---------------------------------------------------------------------------

const COMPACTION_PROVIDER_REGISTRY_STATE = Symbol.for("openclaw.compactionProviderRegistryState");

type CompactionProviderRegistryState = {
  providers: Map<string, CompactionProvider>;
};

// Keep compaction-provider registrations process-global so duplicated dist
// chunks still share one registry map at runtime.
function getCompactionProviderRegistryState(): CompactionProviderRegistryState {
  const globalState = globalThis as typeof globalThis & {
    [COMPACTION_PROVIDER_REGISTRY_STATE]?: CompactionProviderRegistryState;
  };
  if (!globalState[COMPACTION_PROVIDER_REGISTRY_STATE]) {
    globalState[COMPACTION_PROVIDER_REGISTRY_STATE] = {
      providers: new Map<string, CompactionProvider>(),
    };
  }
  return globalState[COMPACTION_PROVIDER_REGISTRY_STATE];
}

/**
 * Register a compaction provider implementation.
 */
export function registerCompactionProvider(provider: CompactionProvider): void {
  getCompactionProviderRegistryState().providers.set(provider.id, provider);
}

/**
 * Return the provider for the given id, or undefined.
 */
export function getCompactionProvider(id: string): CompactionProvider | undefined {
  return getCompactionProviderRegistryState().providers.get(id);
}

/**
 * List all registered compaction provider ids.
 */
export function listCompactionProviderIds(): string[] {
  return [...getCompactionProviderRegistryState().providers.keys()];
}
