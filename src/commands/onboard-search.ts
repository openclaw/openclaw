import type { OpenClawConfig } from "../config/config.js";
import {
  DEFAULT_SECRET_PROVIDER_ALIAS,
  type SecretInput,
  type SecretRef,
  hasConfiguredSecretInput,
  normalizeSecretInputString,
} from "../config/types.secrets.js";
import type { RuntimeEnv } from "../runtime.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import type { SecretInputMode } from "./onboard-types.js";

export type SearchProvider = "brave" | "gemini" | "grok" | "kimi" | "perplexity";

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
    value: "brave",
    label: "Brave Search",
    hint: "Structured results · country/language/time filters",
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
  {
    value: "perplexity",
    label: "Perplexity Search",
    hint: "Structured results · domain/country/language/time filters",
    envKeys: ["PERPLEXITY_API_KEY"],
    placeholder: "pplx-...",
    signupUrl: "https://www.perplexity.ai/settings/api",
  },
] as const;

export function hasKeyInEnv(entry: SearchProviderEntry): boolean {
  return entry.envKeys.some((k) => Boolean(process.env[k]?.trim()));
}

function rawKeyValue(config: OpenClawConfig, provider: SearchProvider): unknown {
  const search = config.tools?.web?.search;
  switch (provider) {
    case "brave":
      return search?.apiKey;
    case "gemini":
      return search?.gemini?.apiKey;
    case "grok":
      return search?.grok?.apiKey;
    case "kimi":
      return search?.kimi?.apiKey;
    case "perplexity":
      return search?.perplexity?.apiKey;
  }
}

/** Returns the plaintext key string, or undefined for SecretRefs/missing. */
export function resolveExistingKey(
  config: OpenClawConfig,
  provider: SearchProvider,
): string | undefined {
  return normalizeSecretInputString(rawKeyValue(config, provider));
}

/** Returns true if a key is configured (plaintext string or SecretRef). */
export function hasExistingKey(config: OpenClawConfig, provider: SearchProvider): boolean {
  return hasConfiguredSecretInput(rawKeyValue(config, provider));
}

/** Build an env-backed SecretRef for a search provider. */
function buildSearchEnvRef(provider: SearchProvider): SecretRef {
  const entry = SEARCH_PROVIDER_OPTIONS.find((e) => e.value === provider);
  const envVar = entry?.envKeys.find((k) => Boolean(process.env[k]?.trim())) ?? entry?.envKeys[0];
  if (!envVar) {
    throw new Error(
      `No env var mapping for search provider "${provider}" in secret-input-mode=ref.`,
    );
  }
  return { source: "env", provider: DEFAULT_SECRET_PROVIDER_ALIAS, id: envVar };
}

/** Resolve a plaintext key into the appropriate SecretInput based on mode. */
function resolveSearchSecretInput(
  provider: SearchProvider,
  key: string,
  secretInputMode?: SecretInputMode,
): SecretInput {
  const useSecretRefMode = secretInputMode === "ref"; // pragma: allowlist secret
  if (useSecretRefMode) {
    return buildSearchEnvRef(provider);
  }
  return key;
}

export function applySearchKey(
  config: OpenClawConfig,
  provider: SearchProvider,
  key: SecretInput,
): OpenClawConfig {
  const search = { ...config.tools?.web?.search, provider, enabled: true };
  switch (provider) {
    case "brave":
      search.apiKey = key;
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
    case "perplexity":
      search.perplexity = { ...search.perplexity, apiKey: key };
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

function preserveDisabledState(original: OpenClawConfig, result: OpenClawConfig): OpenClawConfig {
  if (original.tools?.web?.search?.enabled !== false) {
    return result;
  }
  return {
    ...result,
    tools: {
      ...result.tools,
      web: { ...result.tools?.web, search: { ...result.tools?.web?.search, enabled: false } },
    },
  };
}

export type SetupSearchOptions = {
  quickstartDefaults?: boolean;
  secretInputMode?: SecretInputMode;
};

const DEFAULT_X_SEARCH_MODEL = "grok-4-1-fast-non-reasoning";

const GROK_MODEL_OPTIONS = [
  {
    value: "grok-4-1-fast-non-reasoning",
    label: "grok-4-1-fast-non-reasoning",
    hint: "default · fast, no reasoning",
  },
  { value: "grok-4-1-fast", label: "grok-4-1-fast", hint: "fast with reasoning" },
] as const;

function hasXSearchKeyInEnv(): boolean {
  return Boolean(process.env["XAI_API_KEY"]?.trim());
}

function resolveExistingXSearchKey(config: OpenClawConfig): string | undefined {
  return normalizeSecretInputString(config.tools?.web?.x_search?.apiKey);
}

function hasExistingXSearchKey(config: OpenClawConfig): boolean {
  return hasConfiguredSecretInput(config.tools?.web?.x_search?.apiKey);
}

function applyXSearchConfig(
  config: OpenClawConfig,
  opts: { enabled: boolean; apiKey?: SecretInput; model?: string },
): OpenClawConfig {
  const existing = config.tools?.web?.x_search ?? {};
  return {
    ...config,
    tools: {
      ...config.tools,
      web: {
        ...config.tools?.web,
        x_search: {
          ...existing,
          enabled: opts.enabled,
          ...(opts.apiKey !== undefined ? { apiKey: opts.apiKey } : {}),
          ...(opts.model ? { model: opts.model } : {}),
        },
      },
    },
  };
}

export async function setupXSearch(
  config: OpenClawConfig,
  _runtime: RuntimeEnv,
  prompter: WizardPrompter,
  opts?: SetupSearchOptions,
): Promise<OpenClawConfig> {
  const existingEnabled = config.tools?.web?.x_search?.enabled;
  const existingKey = resolveExistingXSearchKey(config);
  const keyConfigured = hasExistingXSearchKey(config);
  const envAvailable = hasXSearchKeyInEnv();
  const existingModel = config.tools?.web?.x_search?.model;

  // If already explicitly disabled, leave it alone
  if (existingEnabled === false) {
    return config;
  }

  await prompter.note(
    [
      "x_search lets your agent search X (formerly Twitter) posts via xAI Grok.",
      "Requires an xAI API key (XAI_API_KEY).",
      "Docs: https://docs.openclaw.ai/tools/web",
    ].join("\n"),
    "X search",
  );

  type EnableChoice = "yes" | "skip";
  const alreadyConfigured = keyConfigured || envAvailable;
  const enableChoice = await prompter.select<EnableChoice>({
    message: "Enable x_search with Grok?",
    options: [
      {
        value: "yes" as const,
        label: "Yes, enable x_search",
        hint: alreadyConfigured ? "xAI key detected" : "requires XAI_API_KEY",
      },
      {
        value: "skip" as const,
        label: "Skip for now",
        hint: "configure later with openclaw configure --section web",
      },
    ],
    initialValue: alreadyConfigured ? "yes" : "skip",
  });

  if (enableChoice === "skip") {
    return config;
  }

  // Model selection — always prompt so the user can choose regardless of quickstart/secret-ref mode
  const defaultModel =
    existingModel && GROK_MODEL_OPTIONS.some((m) => m.value === existingModel)
      ? existingModel
      : DEFAULT_X_SEARCH_MODEL;

  const modelPick = await prompter.select<string>({
    message: "Grok model for x_search",
    options: [
      ...GROK_MODEL_OPTIONS.map((m) => ({ ...m })),
      { value: "__custom__", label: "Enter custom model name", hint: "" },
    ],
    initialValue: defaultModel,
  });

  let finalModel = modelPick === "__custom__" ? DEFAULT_X_SEARCH_MODEL : modelPick;
  if (modelPick === "__custom__") {
    const customModel = await prompter.text({
      message: "Custom Grok model name",
      placeholder: DEFAULT_X_SEARCH_MODEL,
    });
    finalModel = customModel?.trim() || DEFAULT_X_SEARCH_MODEL;
  }

  // Quickstart: key already available — skip key prompt
  if (opts?.quickstartDefaults && alreadyConfigured) {
    return applyXSearchConfig(config, {
      enabled: true,
      ...(existingKey ? { apiKey: existingKey } : {}),
      model: finalModel,
    });
  }

  // Secret-ref mode
  const useSecretRefMode = opts?.secretInputMode === "ref"; // pragma: allowlist secret
  if (useSecretRefMode) {
    const ref: SecretRef = {
      source: "env",
      provider: DEFAULT_SECRET_PROVIDER_ALIAS,
      id: "XAI_API_KEY",
    };
    if (!keyConfigured) {
      await prompter.note(
        [
          "Secret references enabled — OpenClaw will store a reference instead of the API key.",
          `Env var: XAI_API_KEY${envAvailable ? " (detected)" : ""}.`,
          ...(envAvailable ? [] : ["Set XAI_API_KEY in the Gateway environment."]),
        ].join("\n"),
        "X search",
      );
    }
    return applyXSearchConfig(config, { enabled: true, apiKey: ref, model: finalModel });
  }

  // Prompt for API key
  const keyInput = await prompter.text({
    message: keyConfigured
      ? "xAI API key (leave blank to keep current)"
      : envAvailable
        ? "xAI API key (leave blank to use XAI_API_KEY env var)"
        : "xAI API key",
    placeholder: keyConfigured ? "Leave blank to keep current" : "xai-...",
  });

  const key = keyInput?.trim() ?? "";
  const resolvedKey: SecretInput | undefined = key ? key : existingKey ? existingKey : undefined;

  if (!resolvedKey && !envAvailable) {
    await prompter.note(
      [
        "No API key stored — x_search won't work until XAI_API_KEY is available.",
        "Get your key at: https://console.x.ai/",
        "Docs: https://docs.openclaw.ai/tools/web",
      ].join("\n"),
      "X search",
    );
    return config;
  }

  return applyXSearchConfig(config, {
    enabled: true,
    ...(resolvedKey ? { apiKey: resolvedKey } : {}),
    model: finalModel,
  });
}

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
    const configured = hasExistingKey(config, entry.value) || hasKeyInEnv(entry);
    const hint = configured ? `${entry.hint} · configured` : entry.hint;
    return { value: entry.value, label: entry.label, hint };
  });

  const defaultProvider: SearchProvider = (() => {
    if (existingProvider && SEARCH_PROVIDER_OPTIONS.some((e) => e.value === existingProvider)) {
      return existingProvider;
    }
    const detected = SEARCH_PROVIDER_OPTIONS.find(
      (e) => hasExistingKey(config, e.value) || hasKeyInEnv(e),
    );
    if (detected) {
      return detected.value;
    }
    return SEARCH_PROVIDER_OPTIONS[0].value;
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
  const keyConfigured = hasExistingKey(config, choice);
  const envAvailable = hasKeyInEnv(entry);

  if (opts?.quickstartDefaults && (keyConfigured || envAvailable)) {
    const result = existingKey
      ? applySearchKey(config, choice, existingKey)
      : applyProviderOnly(config, choice);
    return preserveDisabledState(config, result);
  }

  const useSecretRefMode = opts?.secretInputMode === "ref"; // pragma: allowlist secret
  if (useSecretRefMode) {
    if (keyConfigured) {
      return preserveDisabledState(config, applyProviderOnly(config, choice));
    }
    const ref = buildSearchEnvRef(choice);
    await prompter.note(
      [
        "Secret references enabled — OpenClaw will store a reference instead of the API key.",
        `Env var: ${ref.id}${envAvailable ? " (detected)" : ""}.`,
        ...(envAvailable ? [] : [`Set ${ref.id} in the Gateway environment.`]),
        "Docs: https://docs.openclaw.ai/tools/web",
      ].join("\n"),
      "Web search",
    );
    return applySearchKey(config, choice, ref);
  }

  const keyInput = await prompter.text({
    message: keyConfigured
      ? `${entry.label} API key (leave blank to keep current)`
      : envAvailable
        ? `${entry.label} API key (leave blank to use env var)`
        : `${entry.label} API key`,
    placeholder: keyConfigured ? "Leave blank to keep current" : entry.placeholder,
  });

  const key = keyInput?.trim() ?? "";
  if (key) {
    const secretInput = resolveSearchSecretInput(choice, key, opts?.secretInputMode);
    return applySearchKey(config, choice, secretInput);
  }

  if (existingKey) {
    return preserveDisabledState(config, applySearchKey(config, choice, existingKey));
  }

  if (keyConfigured || envAvailable) {
    return preserveDisabledState(config, applyProviderOnly(config, choice));
  }

  await prompter.note(
    [
      "No API key stored — web_search won't work until a key is available.",
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
        },
      },
    },
  };
}
