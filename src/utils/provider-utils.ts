/**
 * Utility functions for provider-specific logic and capabilities.
 */

/**
 * Returns true if the provider requires reasoning to be wrapped in tags
 * (e.g. <think> and <final>) in the text stream, rather than using native
 * API fields for reasoning/thinking.
 */
export function isReasoningTagProvider(provider: string | undefined | null): boolean {
  if (!provider) {
    return false;
  }
  const normalized = provider.trim().toLowerCase();

  // Check for exact matches or known prefixes/substrings for reasoning providers
  if (
    normalized === "ollama" ||
    normalized === "google-gemini-cli" ||
    normalized === "google-generative-ai"
  ) {
    return true;
  }

  // Handle google-antigravity and its model variations (e.g. google-antigravity/gemini-3)
  if (normalized.includes("google-antigravity")) {
    return true;
  }

  // NOTE: MiniMax was previously included here but removed because:
  // 1. MiniMax models don't reliably output <think>/<final> tags
  // 2. enforceFinalTag=true causes all content to be stripped → "(no output)"
  // 3. MiniMax's reasoning is handled differently (not via text stream tags)
  // See: https://github.com/openclaw/openclaw/issues/4499

  return false;
}
