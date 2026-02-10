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

/** Default timeout for individual secret resolution (30 seconds). */
const DEFAULT_RESOLVE_TIMEOUT_MS = 30_000;

/** Maximum concurrent secret resolutions to avoid rate limiting. */
const DEFAULT_MAX_CONCURRENCY = 5;

/** Wrap a promise with a timeout, clearing the timer when the promise settles. */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Secret resolution timed out after ${ms}ms: ${label}`)),
      ms,
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Default batch resolver that calls `resolve()` for each name with
 * concurrency limiting and per-call timeouts.
 *
 * Used when a provider does not implement `resolveAll`.
 *
 * - Concurrency: max 5 simultaneous requests (avoids rate limiting).
 * - Timeout: 30s per secret (avoids hanging on unresponsive providers).
 *
 * Providers with custom batching needs should implement `resolveAll` directly.
 */
export async function defaultResolveAll(
  provider: SecretsProvider,
  secretNames: string[],
): Promise<Map<string, string>> {
  const results = new Map<string, string>();

  // Process in batches to limit concurrency
  for (let i = 0; i < secretNames.length; i += DEFAULT_MAX_CONCURRENCY) {
    const batch = secretNames.slice(i, i + DEFAULT_MAX_CONCURRENCY);
    const entries = await Promise.all(
      batch.map(async (name) => {
        const value = await withTimeout(provider.resolve(name), DEFAULT_RESOLVE_TIMEOUT_MS, name);
        return [name, value] as const;
      }),
    );
    for (const [name, value] of entries) {
      results.set(name, value);
    }
  }

  return results;
}
