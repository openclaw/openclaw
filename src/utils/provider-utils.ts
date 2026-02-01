/**
 * Utility functions for provider-specific logic and capabilities.
 */

/**
 * Returns true if the provider requires reasoning to be wrapped in tags
 * (e.g. <think> and <final>) in the text stream, rather than using native
 * API fields for reasoning/thinking.
 *
 * NOTE: Only include providers that NATIVELY use <think> and <final> tags.
 * Standard Gemini 2.0 (google-gemini-cli, google-generative-ai) does NOT use
 * these tags natively, but Google Antigravity (Gemini 3.0) does.
 */
export function isReasoningTagProvider(provider: string | undefined | null): boolean {
  if (!provider) {
    return false;
  }
  const normalized = provider.trim().toLowerCase();

  // Check for exact matches or known prefixes/substrings for reasoning providers
  if (normalized === "ollama") {
    return true;
  }

  // Handle google-antigravity and its model variations (e.g. google-antigravity/gemini-3)
  // This is Gemini 3.0 which DOES use reasoning tags natively.
  if (normalized.includes("google-antigravity")) {
    return true;
  }

  // Handle Minimax (M2.1 is chatty/reasoning-like)
  if (normalized.includes("minimax")) {
    return true;
  }

  return false;
}
