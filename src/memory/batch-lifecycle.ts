/**
 * Canonical batch embedding poll/wait lifecycle for all providers.
 * USE THIS — do not write per-provider wait loops.
 * Handles state detection, timeout, error extraction, and configurable polling.
 * @see AGENTS.md "Batch embedding lifecycle" for project-level guidance.
 */

export type BatchLifecycleAdapter<TStatus> = {
  /** Provider name for error messages (e.g., "openai", "voyage", "gemini") */
  label: string;
  /** Fetch current batch status from the API */
  fetchStatus: () => Promise<TStatus>;
  /** Extract the state string from status (e.g., "completed", "SUCCEEDED") */
  resolveState: (status: TStatus) => string;
  /** Check if this state means the batch completed successfully */
  isCompleted: (state: string) => boolean;
  /** Check if this state means the batch failed terminally */
  isFailed: (state: string) => boolean;
  /** Extract the output file ID from a completed status */
  resolveOutputFileId: (status: TStatus) => string | undefined;
  /** Extract error detail from a failed status (optional, for enriched error messages) */
  resolveErrorDetail?: (status: TStatus) => Promise<string | undefined>;
};

export type WaitForBatchParams<TStatus> = {
  adapter: BatchLifecycleAdapter<TStatus>;
  batchId: string;
  wait: boolean;
  pollIntervalMs: number;
  timeoutMs: number;
  debug?: (message: string, data?: Record<string, unknown>) => void;
  /** If provided, used as the status on the first iteration (avoids an extra fetch) */
  initial?: TStatus;
};

export type WaitForBatchResult = {
  outputFileId: string;
};

const MIN_POLL_MS = 250;
const DEFAULT_POLL_MS = 2000;
const DEFAULT_TIMEOUT_MS = 60 * 60 * 1000; // 1h

/** Strip control chars and cap length to prevent log forging from provider error payloads. */
function sanitizeErrorDetail(detail: string, maxLen = 2000): string {
  const singleLine = detail.replace(/[\r\n\t]/g, " ").trim();
  return singleLine.length > maxLen ? `${singleLine.slice(0, maxLen)}…[truncated]` : singleLine;
}

/**
 * Shared poll/wait loop for batch embedding providers.
 *
 * All three providers (OpenAI, Voyage, Gemini) share this structure:
 *   1. Fetch status (or use initial)
 *   2. Extract state string
 *   3. If completed → extract output file ID → return
 *   4. If failed → extract error detail → throw
 *   5. If wait disabled → throw
 *   6. If timed out → throw
 *   7. Log + sleep + loop
 *
 * Provider differences are captured in the adapter record.
 */
export async function waitForBatch<TStatus>(
  params: WaitForBatchParams<TStatus>,
): Promise<WaitForBatchResult> {
  const { adapter, batchId, wait, debug } = params;
  // Clamp poll interval to prevent API hammering; honor caller timeout as-is
  // (the pre-refactor providers passed timeoutMs through without a ceiling).
  const pollIntervalMs = Number.isFinite(params.pollIntervalMs)
    ? Math.max(MIN_POLL_MS, params.pollIntervalMs)
    : DEFAULT_POLL_MS;
  const timeoutMs = Number.isFinite(params.timeoutMs)
    ? Math.max(1, params.timeoutMs)
    : DEFAULT_TIMEOUT_MS;
  const start = Date.now();
  // Use initial status on first iteration to avoid an extra network round-trip
  let current: TStatus | undefined = params.initial;

  while (true) {
    const status = current ?? (await adapter.fetchStatus());
    const state = adapter.resolveState(status);

    if (adapter.isCompleted(state)) {
      const outputFileId = adapter.resolveOutputFileId(status);
      if (!outputFileId) {
        throw new Error(`${adapter.label} batch ${batchId} completed without output file`);
      }
      return { outputFileId };
    }

    if (adapter.isFailed(state)) {
      const detail = adapter.resolveErrorDetail
        ? await adapter.resolveErrorDetail(status)
        : undefined;
      const suffix = detail ? `: ${sanitizeErrorDetail(detail)}` : "";
      throw new Error(`${adapter.label} batch ${batchId} ${state}${suffix}`);
    }

    if (!wait) {
      throw new Error(`${adapter.label} batch ${batchId} still ${state}; wait disabled`);
    }

    if (Date.now() - start > timeoutMs) {
      throw new Error(`${adapter.label} batch ${batchId} timed out after ${timeoutMs}ms`);
    }

    debug?.(`${adapter.label} batch ${batchId} ${state}; waiting ${pollIntervalMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    // Clear current so the next iteration fetches a fresh status
    current = undefined;
  }
}
