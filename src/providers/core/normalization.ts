/**
 * Provider ID normalization.
 * Centralizes all provider name/alias resolution.
 */

import type { ProviderId } from "./types.js";

/**
 * Provider alias mappings.
 * Maps known aliases to canonical provider IDs.
 */
const PROVIDER_ALIASES: Record<string, ProviderId> = {
  // Z.AI / ZAI
  "z.ai": "zai",
  "z-ai": "zai",
  zai: "zai",

  // OpenCode variants
  "opencode-zen": "opencode",
  opencode: "opencode",

  // Qwen variants
  qwen: "qwen-portal",
  "qwen-portal": "qwen-portal",

  // Kimi variants
  "kimi-code": "kimi-coding",
  "kimi-coding": "kimi-coding",

  // Anthropic
  anthropic: "anthropic",
  claude: "anthropic",

  // OpenAI
  openai: "openai",
  "openai-codex": "openai-codex",
  codex: "openai-codex",

  // Google variants
  google: "google",
  gemini: "google",
  "google-gemini-cli": "google-gemini-cli",
  "google-antigravity": "google-antigravity",
  antigravity: "google-antigravity",

  // GitHub
  "github-copilot": "github-copilot",
  copilot: "github-copilot",

  // AWS
  "amazon-bedrock": "amazon-bedrock",
  bedrock: "amazon-bedrock",

  // Others
  mistral: "mistral",
  groq: "groq",
  cerebras: "cerebras",
  openrouter: "openrouter",
  ollama: "ollama",
  minimax: "minimax",
  xiaomi: "xiaomi",
  moonshot: "moonshot",
  venice: "venice",
  xai: "xai",
  "x.ai": "xai",

  // Azure OpenAI
  "azure-openai": "azure-openai",
  azure: "azure-openai",
  "azure-openai-service": "azure-openai",

  // Hugging Face
  huggingface: "huggingface",
  "hugging-face": "huggingface",
  hf: "huggingface",
  "hf-inference": "huggingface",
};

/**
 * Normalize a provider ID to its canonical form.
 * Handles aliases, case variations, and special characters.
 *
 * @param provider - Raw provider ID
 * @returns Normalized provider ID
 *
 * @example
 * normalizeProviderId("z-ai") // "zai"
 * normalizeProviderId("Claude") // "anthropic"
 * normalizeProviderId("OpenAI-Codex") // "openai-codex"
 */
export function normalizeProviderId(provider: string): ProviderId {
  if (!provider || typeof provider !== "string") {
    return provider;
  }

  const normalized = provider.trim().toLowerCase();

  // Check alias map first
  const aliasMatch = PROVIDER_ALIASES[normalized];
  if (aliasMatch) {
    return aliasMatch;
  }

  // Return as-is if no alias found (allows custom providers)
  return normalized;
}

/**
 * Normalize a model ID for a specific provider.
 * Handles provider-specific model name variations.
 *
 * @param provider - Normalized provider ID
 * @param model - Raw model ID
 * @returns Normalized model ID
 */
export function normalizeModelId(provider: ProviderId, model: string): string {
  if (!model || typeof model !== "string") {
    return model;
  }

  const trimmed = model.trim();

  // Anthropic-specific normalization
  if (provider === "anthropic") {
    const lower = trimmed.toLowerCase();
    // Versioned aliases
    if (lower === "opus-4.6") {
      return "claude-opus-4-6";
    }
    if (lower === "opus-4.5") {
      return "claude-opus-4-5";
    }
    if (lower === "sonnet-4.5") {
      return "claude-sonnet-4-5";
    }
    if (lower === "haiku-4.5") {
      return "claude-haiku-4-5";
    }
    // Bare family names resolve to latest version
    if (lower === "opus") {
      return "claude-opus-4-6";
    }
    if (lower === "sonnet") {
      return "claude-sonnet-4-5";
    }
    if (lower === "haiku") {
      return "claude-haiku-4-5";
    }
  }

  // Google-specific normalization
  if (
    provider === "google" ||
    provider === "google-gemini-cli" ||
    provider === "google-antigravity"
  ) {
    // Handle Gemini model naming variations
    const lower = trimmed.toLowerCase();
    if (lower.startsWith("gemini-")) {
      return lower; // Already normalized
    }
    if (lower.startsWith("models/gemini-")) {
      return lower.replace("models/", ""); // Strip "models/" prefix
    }
  }

  return trimmed;
}

/**
 * Parse a model reference string into provider and model components.
 * Supports formats: "provider/model", "provider/model@account", "model" (uses default provider).
 *
 * @param raw - Raw model reference string
 * @param defaultProvider - Default provider to use if not specified
 * @returns Parsed model reference or null if invalid
 *
 * @example
 * parseModelRef("anthropic/claude-opus-4-6") // { provider: "anthropic", model: "claude-opus-4-6" }
 * parseModelRef("opus-4.6", "anthropic") // { provider: "anthropic", model: "claude-opus-4-6" }
 * parseModelRef("anthropic/opus@prod") // { provider: "anthropic", model: "claude-opus-4-5", accountTag: "prod" }
 */
export function parseModelRef(
  raw: string,
  defaultProvider: ProviderId = "anthropic",
): { provider: ProviderId; model: string; accountTag?: string } | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }

  // Extract accountTag if present (format: provider/model@tag or model@tag)
  const atIndex = trimmed.indexOf("@");
  const accountTag = atIndex !== -1 ? trimmed.slice(atIndex + 1).trim() || undefined : undefined;
  const providerModelPart = atIndex !== -1 ? trimmed.slice(0, atIndex).trim() : trimmed;

  // Check if provider is specified (contains "/")
  const slash = providerModelPart.indexOf("/");

  if (slash === -1) {
    // No provider specified, use default
    const provider = normalizeProviderId(defaultProvider);
    const model = normalizeModelId(provider, providerModelPart);
    return { provider, model, accountTag };
  }

  // Provider specified
  const providerRaw = providerModelPart.slice(0, slash).trim();
  const modelRaw = providerModelPart.slice(slash + 1).trim();

  if (!providerRaw || !modelRaw) {
    return null;
  }

  const provider = normalizeProviderId(providerRaw);
  const model = normalizeModelId(provider, modelRaw);

  return { provider, model, accountTag };
}

/**
 * Format a model reference as a string.
 *
 * @param provider - Provider ID
 * @param model - Model ID
 * @param accountTag - Optional account tag
 * @returns Formatted model reference string
 *
 * @example
 * formatModelRef("anthropic", "claude-opus-4-6") // "anthropic/claude-opus-4-6"
 * formatModelRef("anthropic", "opus", "prod") // "anthropic/opus@prod"
 */
export function formatModelRef(provider: ProviderId, model: string, accountTag?: string): string {
  const normalized = normalizeProviderId(provider);
  const base = `${normalized}/${model}`;
  return accountTag ? `${base}@${accountTag}` : base;
}

/**
 * Create a unique key for a provider/model pair.
 * Used for caching and lookups.
 *
 * @param provider - Provider ID
 * @param model - Model ID
 * @returns Unique model key
 */
export function modelKey(provider: ProviderId, model: string): string {
  return formatModelRef(provider, model);
}

/**
 * Check if a provider ID matches any of the given provider IDs or aliases.
 *
 * @param provider - Provider ID to check
 * @param targets - Target provider IDs or aliases
 * @returns True if provider matches any target
 */
export function isProviderMatch(provider: string, ...targets: string[]): boolean {
  const normalized = normalizeProviderId(provider);
  return targets.some((target) => normalizeProviderId(target) === normalized);
}
