import type { ModelRef } from "../model-selection.js";
import { parseModelRef, modelKey } from "../model-selection.js";

/**
 * Extract provider from a model reference string or ModelRef object.
 * Handles both "provider/model" and ModelRef formats.
 */
export function getProviderFromModel(modelRef: string | ModelRef | undefined): string | null {
  if (!modelRef) {
    return null;
  }

  // If it's already a ModelRef object
  if (typeof modelRef === "object" && "provider" in modelRef) {
    return modelRef.provider?.trim() || null;
  }

  // If it's a string, parse it
  if (typeof modelRef === "string") {
    const parsed = parseModelRef(modelRef, "anthropic"); // Default provider for parsing
    return parsed?.provider || null;
  }

  return null;
}

/**
 * Shared provider → model hierarchy map.
 * Models are ordered from most to least advanced within each provider.
 * Both getMostAdvancedModelForProvider and getProviderModelHierarchy
 * reference this single constant to avoid duplication.
 */
const PROVIDER_MODEL_HIERARCHY: Record<string, string[]> = {
  anthropic: [
    "claude-opus-4-5",
    "claude-sonnet-4-5",
    "claude-haiku-4-5",
    "claude-3-5-sonnet-20241022",
    "claude-3-5-haiku-20241022",
    "claude-3-opus-20240229",
    "claude-3-sonnet-20240229",
    "claude-3-haiku-20240307",
  ],
  openai: ["gpt-5.2", "gpt-5", "gpt-4o", "gpt-4o-mini", "gpt-4-turbo", "gpt-4", "gpt-3.5-turbo"],
  "openai-codex": ["gpt-5.2", "gpt-5", "o1-pro", "o1", "o1-mini", "gpt-4o", "gpt-4o-mini"],
  google: [
    "gemini-exp-1206",
    "gemini-exp-1121",
    "gemini-1.5-pro",
    "gemini-1.5-flash",
    "gemini-1.0-pro",
  ],
  groq: [
    "llama-3.3-70b-versatile",
    "llama-3.1-70b-versatile",
    "llama-3.1-8b-instant",
    "mixtral-8x7b-32768",
    "gemma-7b-it",
  ],
  perplexity: [
    "llama-3.1-sonar-huge-128k-online",
    "llama-3.1-sonar-large-128k-online",
    "llama-3.1-sonar-small-128k-online",
  ],
  xai: ["grok-2", "grok-1"],
  cohere: ["command-r-plus", "command-r", "command"],
  mistral: ["mistral-large-2407", "mistral-medium", "mistral-small"],
  "claude-cli": ["claude-3-5-sonnet-20241022", "claude-3-opus-20240229"],
  deepseek: ["deepseek-v3", "deepseek-v2.5", "deepseek-coder"],
};

/**
 * Get the most advanced model for a given provider.
 * Returns the top-tier model within the provider's hierarchy.
 */
export function getMostAdvancedModelForProvider(provider: string): ModelRef | null {
  const normalizedProvider = provider.toLowerCase().trim();
  const models = PROVIDER_MODEL_HIERARCHY[normalizedProvider];
  if (!models || models.length === 0) {
    return null;
  }

  // Return the most advanced (first) model
  return {
    provider: normalizedProvider,
    model: models[0],
  };
}

/**
 * Get the complete model hierarchy for a provider.
 * Returns models ordered from most to least advanced.
 */
export function getProviderModelHierarchy(provider: string): string[] {
  const normalizedProvider = provider.toLowerCase().trim();
  return PROVIDER_MODEL_HIERARCHY[normalizedProvider] || [];
}

/**
 * Check if a provider is supported for inheritance.
 */
export function isSupportedProvider(provider: string): boolean {
  const normalizedProvider = provider.toLowerCase().trim();
  const supportedProviders = [
    "anthropic",
    "openai",
    "openai-codex",
    "google",
    "groq",
    "perplexity",
    "xai",
    "cohere",
    "mistral",
    "claude-cli",
    "deepseek",
  ];
  return supportedProviders.includes(normalizedProvider);
}

/**
 * Get inheritance-compatible model for a subagent.
 * Takes parent model and returns the most advanced model in the same provider.
 */
export function getInheritedModel(parentModelRef: string | ModelRef | undefined): ModelRef | null {
  const provider = getProviderFromModel(parentModelRef);
  if (!provider) {
    return null;
  }

  if (!isSupportedProvider(provider)) {
    return null;
  }

  return getMostAdvancedModelForProvider(provider);
}

/**
 * Format model reference as string for display/config.
 */
export function formatModelRef(modelRef: ModelRef): string {
  return `${modelRef.provider}/${modelRef.model}`;
}

/**
 * Validate that a model exists within a provider's hierarchy.
 */
export function isModelInProviderHierarchy(provider: string, model: string): boolean {
  const hierarchy = getProviderModelHierarchy(provider);
  return hierarchy.includes(model);
}
