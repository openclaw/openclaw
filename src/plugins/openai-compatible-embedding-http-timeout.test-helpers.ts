// Test helpers for OpenAI-compatible embedding HTTP hang floors.
type OpenAICompatibleEmbeddingTimeoutOverride = {
  queryMs?: number;
  batchMs?: number;
};

const EMBEDDING_TIMEOUT_TEST_HOOK_KEY = Symbol.for("openclaw.openaiCompatibleEmbeddingTimeout");

type EmbeddingTimeoutTestHook = {
  override?: OpenAICompatibleEmbeddingTimeoutOverride;
};

function testHook(): EmbeddingTimeoutTestHook {
  const globalStore = globalThis as Record<PropertyKey, unknown>;
  const existing = globalStore[EMBEDDING_TIMEOUT_TEST_HOOK_KEY] as
    | EmbeddingTimeoutTestHook
    | undefined;
  if (existing) {
    return existing;
  }
  const created: EmbeddingTimeoutTestHook = {};
  globalStore[EMBEDDING_TIMEOUT_TEST_HOOK_KEY] = created;
  return created;
}

/** Production defaults mirrored for assertions (must match http-timeout module). */
export const OPENAI_COMPATIBLE_EMBEDDING_QUERY_TIMEOUT_MS = 60_000;
export const OPENAI_COMPATIBLE_EMBEDDING_BATCH_TIMEOUT_MS = 600_000;

/** Shorten or clear no-signal hang floors for hung-socket proofs. */
export function setOpenAICompatibleEmbeddingRequestTimeoutMsForTest(
  timeoutMs?: number | OpenAICompatibleEmbeddingTimeoutOverride,
): void {
  const hook = testHook();
  if (timeoutMs === undefined) {
    hook.override = undefined;
    return;
  }
  if (typeof timeoutMs === "number") {
    hook.override = { queryMs: timeoutMs, batchMs: timeoutMs };
    return;
  }
  hook.override = timeoutMs;
}
