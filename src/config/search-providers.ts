/**
 * Shared search-provider metadata used by the onboarding TUI and configure wizard.
 */

export const SEARCH_PROVIDER_OPTIONS = [
  { value: "brave", label: "Brave Search", hint: "Free tier available" },
  { value: "parallel", label: "Parallel", hint: "LLM-optimized excerpts" },
  { value: "perplexity", label: "Perplexity", hint: "AI-synthesized answers" },
  { value: "grok", label: "Grok (xAI)", hint: "xAI web search" },
  { value: "gemini", label: "Gemini", hint: "Google Search grounding" },
  { value: "kimi", label: "Kimi (Moonshot)", hint: "Native web search" },
] as const;

export type SearchProviderValue = (typeof SEARCH_PROVIDER_OPTIONS)[number]["value"];

export const PROVIDER_ENV_VARS: Record<SearchProviderValue, string> = {
  brave: "BRAVE_API_KEY",
  parallel: "PARALLEL_API_KEY",
  perplexity: "PERPLEXITY_API_KEY",
  grok: "XAI_API_KEY",
  gemini: "GEMINI_API_KEY",
  kimi: "KIMI_API_KEY",
};

export const PROVIDER_PLACEHOLDERS: Record<SearchProviderValue, string> = {
  brave: "BSA...",
  parallel: "par-...",
  perplexity: "pplx-...",
  grok: "xai-...",
  gemini: "AIza...",
  kimi: "sk-...",
};
