/**
 * Structured INFO-level logging for model API request/response timing and payload size.
 *
 * Each inference attempt emits exactly two log lines — one immediately before the
 * model API call and one in the corresponding finally block — forming a paired record:
 *
 *   [model/api] → request: 14.2 KB (~3626 tokens) provider=anthropic model=claude-sonnet-4-6 history=12msg runId=abc123
 *   [model/api] ← response: ok 2.1 KB 1243ms provider=anthropic model=claude-sonnet-4-6 runId=abc123
 *
 * The shared runId field makes the pair unambiguously correlatable in concurrent log
 * streams (multiple sessions running simultaneously produce interleaved lines).
 * Operators can isolate a single attempt with: grep 'runId=<id>'
 *
 * Sizes are derived from character counts and converted to KB (1 decimal place).
 * Token counts use the widely-accepted 4 chars/token heuristic for English prose;
 * the estimate is labelled "~N tokens" in the output to signal its approximate nature.
 *
 * These logs are emitted at INFO level under the "model/api" subsystem and are
 * independent of the diagnostics flag — they are always-on when INFO logging is enabled.
 */
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("model/api");

/** Convert a character count to a human-readable KB string (1 decimal place). */
export function charsToKbString(chars: number): string {
  return `${(chars / 1024).toFixed(1)} KB`;
}

/**
 * Rough token estimate using the 4 chars/token heuristic.
 * Suitable for English-dominant content; treated as approximate in all log output.
 */
export function estimateTokens(chars: number): number {
  return Math.max(0, Math.round(chars / 4));
}

export type ModelApiRequestLogOptions = {
  /** Unique identifier for this inference attempt. Shared with the response log for correlation. */
  runId: string;
  /** Provider identifier (e.g. "anthropic", "openai"). */
  provider: string;
  /** Model identifier as sent to the API. */
  model: string;
  /** Character length of the effective prompt (after hook modifications). */
  promptChars: number;
  /** Character length of the system prompt, if any. */
  systemPromptChars: number;
  /** Number of history messages in the active session at call time. */
  historyMessages: number;
  /** Approximate character length of conversation history (all prior messages). */
  historyChars?: number;
  /** Number of images attached to this request. */
  imagesCount: number;
};

export type ModelApiResponseLogOptions = {
  /** Unique identifier for this inference attempt. Must match the paired request log. */
  runId: string;
  /** Provider identifier. */
  provider: string;
  /** Model identifier. */
  model: string;
  /** Wall-clock duration of the model API call in milliseconds. */
  durationMs: number;
  /** Total character length of all assistant text segments in the response. */
  responseChars: number;
  /** Whether the call ended in an error (network, timeout, API error). */
  error: boolean;
};

/**
 * Emit a structured INFO log line immediately before the model API call.
 *
 * Example output (no images):
 *   [model/api] → request: 14.2 KB (~3626 tokens) provider=anthropic model=claude-sonnet-4-6 history=12msg runId=abc123
 * Example output (with images):
 *   [model/api] → request: 14.2 KB (~3626 tokens) provider=anthropic model=claude-sonnet-4-6 history=12msg images=3 runId=abc123
 */
export function logModelApiRequest(opts: ModelApiRequestLogOptions): void {
  const totalChars = opts.promptChars + opts.systemPromptChars + (opts.historyChars ?? 0);
  const kb = charsToKbString(totalChars);
  const tokens = estimateTokens(totalChars);
  const imagesSuffix = opts.imagesCount > 0 ? ` images=${opts.imagesCount}` : "";
  log.info(
    `→ request: ${kb} (~${tokens} tokens) provider=${opts.provider} model=${opts.model} history=${opts.historyMessages}msg${imagesSuffix} runId=${opts.runId}`,
  );
}

/**
 * Emit a structured INFO log line immediately after the model API call resolves.
 *
 * Example output (success):
 *   [model/api] ← response: ok 2.1 KB 1243ms provider=anthropic model=claude-sonnet-4-6 runId=abc123
 * Example output (error):
 *   [model/api] ← response: error 0.0 KB 312ms provider=anthropic model=claude-sonnet-4-6 runId=abc123
 */
export function logModelApiResponse(opts: ModelApiResponseLogOptions): void {
  const kb = charsToKbString(opts.responseChars);
  const outcome = opts.error ? "error" : "ok";
  log.info(
    `← response: ${outcome} ${kb} ${opts.durationMs}ms provider=${opts.provider} model=${opts.model} runId=${opts.runId}`,
  );
}
