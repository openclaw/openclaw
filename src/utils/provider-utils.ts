/**
 * Utility functions for provider-specific logic and capabilities.
 */

import { resolveProviderCapabilities } from "../agents/provider-capabilities.js";

/**
 * Returns true if the provider requires reasoning to be wrapped in tags
 * (e.g. <think> and <final>) in the text stream, rather than using native
 * API fields for reasoning/thinking.
 */
export function isReasoningTagProvider(provider: string | undefined | null): boolean {
  if (!provider) {
    return false;
  }
  return resolveProviderCapabilities({ provider }).reasoningFormat === "tags";
}
