// Hang floors and shared header helpers for OpenAI-compatible embedding HTTP.
export type OpenAICompatibleEmbeddingTimeoutKind = "query" | "batch";

type OpenAICompatibleEmbeddingTimeoutOverride = {
  queryMs?: number;
  batchMs?: number;
};

const DEFAULT_QUERY_TIMEOUT_MS = 60_000;
const DEFAULT_BATCH_TIMEOUT_MS = 600_000;

const EMBEDDING_TIMEOUT_TEST_HOOK_KEY = Symbol.for("openclaw.openaiCompatibleEmbeddingTimeout");

type EmbeddingTimeoutTestHook = {
  override?: OpenAICompatibleEmbeddingTimeoutOverride;
};

function readTestOverride(): OpenAICompatibleEmbeddingTimeoutOverride | undefined {
  // Vitest hang proofs shorten floors via globalThis; production never sets this.
  const globalStore = globalThis as Record<PropertyKey, unknown>;
  const hook = globalStore[EMBEDDING_TIMEOUT_TEST_HOOK_KEY] as EmbeddingTimeoutTestHook | undefined;
  return hook?.override;
}

/** Resolve the transport timeout, composing only when the caller omitted a signal. */
export function resolveOpenAICompatibleEmbeddingTimeoutMs(params: {
  signal?: AbortSignal;
  kind: OpenAICompatibleEmbeddingTimeoutKind;
}): number | undefined {
  // Memory search / tool callers already install deadlines on their AbortSignal.
  if (params.signal) {
    return undefined;
  }
  const override = readTestOverride();
  if (params.kind === "query") {
    return override?.queryMs ?? DEFAULT_QUERY_TIMEOUT_MS;
  }
  return override?.batchMs ?? DEFAULT_BATCH_TIMEOUT_MS;
}

/** Normalize an HTTP header name for OpenAI-compatible embedding requests. */
export function normalizeOpenAICompatibleEmbeddingHeaderName(name: string): string {
  return name.trim().toLowerCase();
}

function isSensitiveHeaderName(name: string): boolean {
  return (
    name === "authorization" ||
    name === "proxy-authorization" ||
    name.includes("api-key") ||
    name.includes("token") ||
    name.includes("secret")
  );
}

/** Drop credential-bearing headers from runtime cache identity. */
export function sanitizeOpenAICompatibleEmbeddingCacheHeaders(
  headers: Record<string, string>,
): Record<string, string> | undefined {
  const safeHeaders = Object.fromEntries(
    Object.entries(headers).filter(([name]) => !isSensitiveHeaderName(name)),
  );
  return Object.keys(safeHeaders).length > 0 ? safeHeaders : undefined;
}
