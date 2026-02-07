/**
 * Secrets provider interface for pluggable secret resolution.
 *
 * Providers resolve secret names to their plaintext values at config load time.
 * Each provider implements at minimum the `resolve` method; `resolveAll` is an
 * optional batch optimization.
 */

/** A pluggable secrets provider that resolves secret names to values. */
export interface SecretsProvider {
  /** Human-readable provider name (e.g. "gcp", "aws"). */
  readonly name: string;

  /** Resolve a single secret by name. */
  resolve(secretName: string): Promise<string>;

  /**
   * Batch-resolve multiple secrets. Optional optimization — the default
   * implementation calls `resolve()` for each name in parallel via `Promise.all`.
   *
   * Providers with rate limits or concurrency constraints should override this
   * method to control batching/throttling (e.g. limiting concurrent requests).
   */
  resolveAll?(secretNames: string[]): Promise<Map<string, string>>;

  /**
   * Optional cleanup hook for releasing resources (connections, caches, etc.).
   * Called when the config loader is done with the provider.
   */
  dispose?(): Promise<void>;
}

/**
 * Default batch resolver that calls `resolve()` for each name.
 * Used when a provider does not implement `resolveAll`.
 *
 * **Note:** All names are resolved concurrently via `Promise.all`. Providers
 * with rate limits should implement `resolveAll` directly to control concurrency.
 */
export async function defaultResolveAll(
  provider: SecretsProvider,
  secretNames: string[],
): Promise<Map<string, string>> {
  const results = new Map<string, string>();
  // Resolve in parallel for better performance
  const entries = await Promise.all(
    secretNames.map(async (name) => [name, await provider.resolve(name)] as const),
  );
  for (const [name, value] of entries) {
    results.set(name, value);
  }
  return results;
}
