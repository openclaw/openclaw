import { resolveEmbeddedSessionContextLimits } from "../../agents/embedded-agent-runner/run/session-context-limits.js";
import { parseNonNegativeByteSize } from "../../config/byte-size.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveMaxActiveTranscriptBytes } from "../../context-engine/transcript-byte-limit.js";

/**
 * The preflight byte guard. Past the history hydration cap the model's history window steps
 * forward and rewrites the start of an already-sent request, so an unset limit uses that cap:
 * compacting first makes the point an allowed, summarized rebuild instead of an unannounced
 * prompt-cache break. An explicit 0 still disables the guard.
 */
export function resolvePreflightTranscriptByteLimit(
  cfg: OpenClawConfig,
  contextTokenBudget: number,
): { maxBytes?: number; configured: boolean } {
  const configured = resolveMaxActiveTranscriptBytes(cfg);
  if (configured !== undefined) {
    return { maxBytes: configured, configured: true };
  }
  if (parseNonNegativeByteSize(cfg.agents?.defaults?.compaction?.maxActiveTranscriptBytes) === 0) {
    return { configured: true };
  }
  return {
    maxBytes: resolveEmbeddedSessionContextLimits({ contextTokenBudget }).maxBytes,
    configured: false,
  };
}
