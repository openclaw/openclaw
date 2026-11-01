/** Builds recovery instructions while preserving the existing session mapping. */
export function buildContextOverflowRecoveryText(): string {
  return (
    "⚠️ Auto-compaction could not recover this turn. I kept this conversation mapped to the current session. Please try again, use /compact, or use /new to start a fresh session." +
    "\n\nTry starting a fresh session or using a model with a larger context window."
  );
}
