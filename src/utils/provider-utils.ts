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

  // Check for exact matches or known prefixes/substrings for reasoning providers.
  // Note: Ollama is intentionally excluded - its OpenAI-compatible endpoint
  // handles reasoning natively via the `reasoning` field in streaming chunks,
  // so tag-based enforcement is unnecessary and causes all output to be
  // discarded as "(no output)" (#2279).
  if (
    normalized === "google" ||
    normalized === "google-gemini-cli" ||
    normalized === "google-generative-ai"
  ) {
    return true;
  }

  // Handle Minimax (M2.5 is chatty/reasoning-like)
  if (normalized.includes("minimax")) {
    return true;
  }

  // NVIDIA NIM providers that emit <think> blocks in text stream
  if (
    normalized.includes("nvidia") ||
    normalized === "nvidia-step" ||
    normalized === "nvidia-kimi-k2"
  ) {
    return true;
  }

  // Local llama-server with reasoning models (e.g. Qwen3.5)
  if (normalized === "local-llama") {
    return true;
  }

  return false;
}
