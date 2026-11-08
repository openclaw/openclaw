import { formatErrorMessage } from "../infra/errors.js";
import { logWarn } from "../logger.js";
import type { MemoryEmbeddingProvider } from "../plugins/memory-embedding-providers.js";
import { createDeferredCore } from "../shared/deferred.js";

const FAILED_EMBEDDING_PROVIDER_SCOPES = new Set<string>();
const EMBEDDING_PROVIDER_ADMISSION_TAILS = new Map<string, Promise<void>>();

export async function acquireEmbeddingProviderLease(
  scopeKey: string,
  signal: AbortSignal,
  create: () => Promise<MemoryEmbeddingProvider>,
  holdForCleanup: (provider: MemoryEmbeddingProvider) => boolean,
): Promise<{ provider: MemoryEmbeddingProvider; release: () => void }> {
  const previous = EMBEDDING_PROVIDER_ADMISSION_TAILS.get(scopeKey) ?? Promise.resolve();
  const createLease = async () => {
    signal.throwIfAborted();
    if (FAILED_EMBEDDING_PROVIDER_SCOPES.has(scopeKey)) {
      throw new Error("Embedding provider cleanup failed; restart the Gateway before retrying.");
    }
    const provider = await create();
    if (signal.aborted) {
      await closeEmbeddingProvider(scopeKey, provider);
      signal.throwIfAborted();
    }
    if (!holdForCleanup(provider)) {
      return { provider, lifecycle: Promise.resolve(), release: () => {} };
    }
    const { promise: lifecycle, resolve: release } = createDeferredCore();
    return { provider, lifecycle, release };
  };
  const acquired = previous.then(createLease, createLease);
  const tail = acquired
    .then(async ({ lifecycle }) => await lifecycle)
    .then(
      () => undefined,
      () => undefined,
    );
  EMBEDDING_PROVIDER_ADMISSION_TAILS.set(scopeKey, tail);
  void tail.then(() => {
    if (EMBEDDING_PROVIDER_ADMISSION_TAILS.get(scopeKey) === tail) {
      EMBEDDING_PROVIDER_ADMISSION_TAILS.delete(scopeKey);
    }
  });
  const { provider, release } = await acquired;
  return { provider, release };
}

export async function closeEmbeddingProvider(
  scopeKey: string,
  provider: MemoryEmbeddingProvider,
): Promise<void> {
  try {
    await provider.close?.();
  } catch (closeErr) {
    // Failed cleanup blocks this scope until restart instead of speculative close retries.
    FAILED_EMBEDDING_PROVIDER_SCOPES.add(scopeKey);
    logWarn(
      `openai-compat: failed to close embeddings provider; restart the Gateway before retrying: ${formatErrorMessage(closeErr)}`,
    );
  }
}

export async function drainRetainedOpenAiEmbeddingProviders(): Promise<void> {
  await Promise.allSettled(EMBEDDING_PROVIDER_ADMISSION_TAILS.values());
}
