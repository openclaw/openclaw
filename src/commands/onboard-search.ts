import type { OpenClawConfig } from "../config/config.js";
import { normalizeSecretInputString } from "../config/types.secrets.js";
import type { RuntimeEnv } from "../runtime.js";
import type { WizardPrompter } from "../wizard/prompts.js";

export type SearchProvider = "perplexity" | "brave" | "gemini" | "grok" | "kimi";

type SearchProviderEntry = {
  value: SearchProvider;
  label: string;
  hint: string;
  envKeys: string[];
  placeholder: string;
  signupUrl: string;
};

export const SEARCH_PROVIDER_OPTIONS: readonly SearchProviderEntry[] = [
  {
    value: "perplexity",
    label: "Perplexity Search",
    hint: "Structured results · domain/language/freshness filters",
    envKeys: ["PERPLEXITY_API_KEY"],
    placeholder: "pplx-...",
    signupUrl: "https://www.perplexity.ai/settings/api",
  },
  {
    value: "brave",
    label: "Brave Search",
    hint: "Structured results · region-specific",
    envKeys: ["BRAVE_API_KEY"],
    placeholder: "BSA...",
    signupUrl: "https://brave.com/search/api/",
  },
  {
    value: "gemini",
    label: "Gemini (Google Search)",
    hint: "Google Search grounding · AI-synthesized",
    envKeys: ["GEMINI_API_KEY"],
    placeholder: "AIza...",
    signupUrl: "https://aistudio.google.com/apikey",
  },
  {
    value: "grok",
    label: "Grok (xAI)",
    hint: "xAI web-grounded responses",
    envKeys: ["XAI_API_KEY"],
    placeholder: "xai-...",
    signupUrl: "https://console.x.ai/",
  },
  {
    value: "kimi",
    label: "Kimi (Moonshot)",
    hint: "Moonshot web search",
    envKeys: ["KIMI_API_KEY", "MOONSHOT_API_KEY"],
    placeholder: "sk-...",
    signupUrl: "https://platform.moonshot.cn/",
  },
] as const;

export function hasKeyInEnv(entry: SearchProviderEntry): boolean {
  return entry.envKeys.some((k) => Boolean(process.env[k]?.trim()));
}

export function resolveExistingKey(
  config: OpenClawConfig,
  provider: SearchProvider,
): string | undefined {
  const search = config.tools?.web?.search;
  switch (provider) {
    case "brave":
      return normalizeSecretInputString(search?.apiKey);
    case "perplexity":
      return normalizeSecretInputString(search?.perplexity?.apiKey);
    case "gemini":
      return normalizeSecretInputString(search?.gemini?.apiKey);
    case "grok":
      return normalizeSecretInputString(search?.grok?.apiKey);
    case "kimi":
      return normalizeSecretInputString(search?.kimi?.apiKey);
  }
}

export function applySearchKey(
  config: OpenClawConfig,
  provider: SearchProvider,
  key: string,
): OpenClawConfig {
  const search = { ...config.tools?.web?.search, provider, enabled: true };
  switch (provider) {
    case "brave":
      search.apiKey = key;
      break;
    case "perplexity":
      search.perplexity = { ...search.perplexity, apiKey: key };
      break;
    case "gemini":
      search.gemini = { ...search.gemini, apiKey: key };
      break;
    case "grok":
      search.grok = { ...search.grok, apiKey: key };
      break;
    case "kimi":
      search.kimi = { ...search.kimi, apiKey: key };
      break;
  }
  return {
    ...config,
    tools: {
      ...config.tools,
      web: { ...config.tools?.web, search },
    },
  };
}

function applyProviderOnly(config: OpenClawConfig, provider: SearchProvider): OpenClawConfig {
  return {
    ...config,
    tools: {
      ...config.tools,
      web: {
        ...config.tools?.web,
        search: {
          ...config.tools?.web?.search,
          provider,
          enabled: true,
        },
      },
    },
  };
}

export type SetupSearchOptions = {
  quickstartDefaults?: boolean;
};

export async function setupSearch(
  config: OpenClawConfig,
  _runtime: RuntimeEnv,
  prompter: WizardPrompter,
  opts?: SetupSearchOptions,
): Promise<OpenClawConfig> {
  await prompter.note(
    [
      "Web search lets your agent look things up online.",
      "Choose a provider and paste your API key.",
      "Docs: https://docs.openclaw.ai/tools/web",
    ].join("\n"),
    "Web search",
  );

  const existingProvider = config.tools?.web?.search?.provider;

  const options = SEARCH_PROVIDER_OPTIONS.map((entry) => {
    const configured = Boolean(resolveExistingKey(config, entry.value)) || hasKeyInEnv(entry);
    const hint = configured ? `${entry.hint} · configured` : entry.hint;
    return { value: entry.value, label: entry.label, hint };
  });

  const defaultProvider: SearchProvider = (() => {
    if (existingProvider) {
      return existingProvider;
    }
    const detected = SEARCH_PROVIDER_OPTIONS.find(
      (e) => Boolean(resolveExistingKey(config, e.value)) || hasKeyInEnv(e),
    );
    if (detected) {
      return detected.value;
    }
    return "perplexity";
  })();

  type PickerValue = SearchProvider | "__skip__";
  const choice = await prompter.select<PickerValue>({
    message: "Search provider",
    options: [
      ...options,
      {
        value: "__skip__" as const,
        label: "Skip for now",
        hint: "Configure later with openclaw configure --section web",
      },
    ],
    initialValue: defaultProvider as PickerValue,
  });

  if (choice === "__skip__") {
    return config;
  }

  const entry = SEARCH_PROVIDER_OPTIONS.find((e) => e.value === choice)!;
  const existingKey = resolveExistingKey(config, choice);
  const envAvailable = hasKeyInEnv(entry);

  if (opts?.quickstartDefaults && (existingKey || envAvailable)) {
    return existingKey
      ? applySearchKey(config, choice, existingKey)
      : applyProviderOnly(config, choice);
  }

  const keyInput = await prompter.text({
    message: existingKey
      ? `${entry.label} API key (leave blank to keep current)`
      : envAvailable
        ? `${entry.label} API key (leave blank to use env var)`
        : `${entry.label} API key`,
    placeholder: existingKey ? "Leave blank to keep current" : entry.placeholder,
  });

  const key = keyInput?.trim() ?? "";
  if (key) {
    return applySearchKey(config, choice, key);
  }

  if (existingKey) {
    return applySearchKey(config, choice, existingKey);
  }

  if (envAvailable) {
    return applyProviderOnly(config, choice);
  }

  await prompter.note(
    [
      "No API key stored — web_search will stay unavailable until you add one.",
      `Get your key at: ${entry.signupUrl}`,
      "Docs: https://docs.openclaw.ai/tools/web",
    ].join("\n"),
    "Web search",
  );

  return {
    ...config,
    tools: {
      ...config.tools,
      web: {
        ...config.tools?.web,
        search: {
          ...config.tools?.web?.search,
          provider: choice,
          enabled: false,
        },
      },
    },
  };
}
