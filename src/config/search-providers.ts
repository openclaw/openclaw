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

export const PROVIDER_ENV_VARS: Record<SearchProviderValue, string | readonly string[]> = {
  brave: "BRAVE_API_KEY",
  parallel: "PARALLEL_API_KEY",
  perplexity: "PERPLEXITY_API_KEY",
  grok: "XAI_API_KEY",
  gemini: "GEMINI_API_KEY",
  kimi: ["KIMI_API_KEY", "MOONSHOT_API_KEY"],
};

/** Check whether the env has a key set for the given provider. */
export function hasProviderEnvKey(provider: SearchProviderValue): boolean {
  const vars = PROVIDER_ENV_VARS[provider];
  const keys = typeof vars === "string" ? [vars] : vars;
  return keys.some((k) => (process.env[k] ?? "").trim() !== "");
}

/** Return the primary env-var name(s) as a display hint. */
export function providerEnvHint(provider: SearchProviderValue): string {
  const vars = PROVIDER_ENV_VARS[provider];
  return typeof vars === "string" ? vars : vars.join(" / ");
}

export const PROVIDER_PLACEHOLDERS: Record<SearchProviderValue, string> = {
  brave: "BSA...",
  parallel: "par-...",
  perplexity: "pplx-...",
  grok: "xai-...",
  gemini: "AIza...",
  kimi: "sk-...",
};

/**
 * Build the `tools.web.fetch` object with Parallel extract toggled based on
 * the selected search provider.  When the provider is `"parallel"`, Parallel
 * extract is enabled and the API key is copied; otherwise an existing Parallel
 * extract config is explicitly disabled so it doesn't linger after a provider
 * switch.
 */
export function applyParallelExtractToggle(
  existingFetch: Record<string, unknown> | undefined,
  provider: SearchProviderValue | undefined,
  apiKey: string | undefined,
): Record<string, unknown> | undefined {
  if (provider === "parallel") {
    return {
      ...existingFetch,
      parallel: {
        ...(existingFetch?.parallel as Record<string, unknown> | undefined),
        enabled: true,
        ...(apiKey ? { apiKey } : {}),
      },
    };
  }

  // Disable Parallel extract when explicitly switching away from Parallel.
  // When provider is undefined (e.g. user disabled web_search), leave fetch config untouched.
  if (provider !== undefined && existingFetch?.parallel) {
    return {
      ...existingFetch,
      parallel: {
        ...(existingFetch.parallel as Record<string, unknown>),
        enabled: false,
      },
    };
  }

  return existingFetch;
}
