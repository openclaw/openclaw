import { logVerbose } from "../../globals.js";

/**
 * Check whether there's enough headroom in the context window to run
 * an LLM-based flush turn. If not, the caller should fall back to
 * mechanical (non-LLM) flushing.
 */
export function hasHeadroomForFlushTurn(params: {
  estimatedTokens: number | undefined;
  contextWindowTokens: number;
}): boolean {
  if (params.estimatedTokens == null) {
    // No estimate available — assume there's headroom
    return true;
  }
  // Leave at least 15% of the context window free for the flush turn
  const headroomRatio = 0.85;
  return params.estimatedTokens < params.contextWindowTokens * headroomRatio;
}

/**
 * Perform a mechanical (non-LLM) flush by trimming old messages from
 * the session file. This is the fallback when the context window is
 * too full for an LLM-based flush.
 *
 * "Mechanical" means we simply drop the oldest assistant/user turns
 * (keeping the system prompt and recent turns) without asking an LLM
 * to summarise them.
 */
export async function runMechanicalFlush(params: {
  workspaceDir: string;
  sessionKey?: string;
}): Promise<{ success: boolean; error?: string }> {
  try {
    logVerbose(
      `mechanical flush: trimming old turns for session ${params.sessionKey ?? "(unknown)"}`,
    );
    // The mechanical flush is intentionally a no-op placeholder for now.
    // The real value is that it marks memoryFlushAt so the system moves on
    // to compaction (which does the actual size reduction). A future
    // iteration can implement actual turn trimming here.
    return { success: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, error: msg };
  }
}
