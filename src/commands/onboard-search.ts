import type { OpenClawConfig } from "../config/config.js";
import {
  DEFAULT_SECRET_PROVIDER_ALIAS,
  type SecretInput,
  type SecretRef,
  hasConfiguredSecretInput,
  normalizeSecretInputString,
} from "../config/types.secrets.js";
import { enablePluginInConfig } from "../plugins/enable.js";
import { resolvePluginWebSearchProviders } from "../plugins/web-search-providers.js";
import type { RuntimeEnv } from "../runtime.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import type { SecretInputMode } from "./onboard-types.js";

export type SearchProvider = NonNullable<
  NonNullable<NonNullable<NonNullable<OpenClawConfig["tools"]>["web"]>["search"]>["provider"]
>;

const SEARCH_PROVIDER_IDS = ["brave", "firecrawl", "gemini", "grok", "kimi", "perplexity"] as const;

function isSearchProvider(value: string): value is SearchProvider {
  return (SEARCH_PROVIDER_IDS as readonly string[]).includes(value);
}

function hasSearchProviderId<T extends { id: string }>(
  provider: T,
): provider is T & { id: SearchProvider } {
  return isSearchProvider(provider.id);
}

type SearchProviderEntry = {
  value: SearchProvider;
  label: string;
  hint: string;
  envKeys: string[];
  placeholder: string;
  signupUrl: string;
};

export const SEARCH_PROVIDER_OPTIONS: readonly SearchProviderEntry[] =
  resolvePluginWebSearchProviders({
    bundledAllowlistCompat: true,
  })
    .filter(hasSearchProviderId)
    .map((provider) => ({
      value: provider.id,
      label: provider.label,
      hint: provider.hint,
      envKeys: provider.envVars,
      placeholder: provider.placeholder,
      signupUrl: provider.signupUrl,
    }));

export function hasKeyInEnv(entry: SearchProviderEntry): boolean {
  return entry.envKeys.some((k) => Boolean(process.env[k]?.trim()));
}

function rawKeyValue(config: OpenClawConfig, provider: SearchProvider): unknown {
  const search = config.tools?.web?.search;
  const entry = resolvePluginWebSearchProviders({
    config,
    bundledAllowlistCompat: true,
  }).find((candidate) => candidate.id === provider);
  return entry?.getCredentialValue(search as Record<string, unknown> | undefined);
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
  const entry = resolvePluginWebSearchProviders({
    config,
    bundledAllowlistCompat: true,
  }).find((candidate) => candidate.id === provider);
  if (entry) {
    entry.setCredentialValue(search as Record<string, unknown>, key);
  }
  const next = {
    ...config,
    tools: {
      ...config.tools,
      web: { ...config.tools?.web, search },
    },
  };
  if (provider !== "firecrawl") {
    return next;
  }
  return enablePluginInConfig(next, "firecrawl").config;
}

function applyProviderOnly(config: OpenClawConfig, provider: SearchProvider): OpenClawConfig {
  const next = {
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
  if (provider !== "firecrawl") {
    return next;
  }
  return enablePluginInConfig(next, "firecrawl").config;
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

export async function setupSearch(
  config: OpenClawConfig,
  _runtime: RuntimeEnv,
  prompter: WizardPrompter,
  opts?: SetupSearchOptions,
): Promise<OpenClawConfig> {
  await prompter.note(
    [
      "网页搜索可让你的智能体在线检索信息。",
      "请选择一个提供方并粘贴 API Key。",
      "文档：https://docs.openclaw.ai/tools/web",
    ].join("\n"),
    "网页搜索",
  );

  const existingProvider = config.tools?.web?.search?.provider;

  const options = SEARCH_PROVIDER_OPTIONS.map((entry) => {
    const configured = hasExistingKey(config, entry.value) || hasKeyInEnv(entry);
    const hint = configured ? `${entry.hint} · 已配置` : entry.hint;
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
    message: "搜索提供方",
    options: [
      ...options,
      {
        value: "__skip__" as const,
        label: "暂时跳过",
        hint: "稍后可通过 openclaw configure --section web 配置",
      },
    ],
    initialValue: defaultProvider,
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
        "已启用密钥引用，OpenClaw 将保存引用而不是 API Key。",
        `环境变量：${ref.id}${envAvailable ? "（已检测到）" : ""}。`,
        ...(envAvailable ? [] : [`请在网关环境中设置 ${ref.id}。`]),
        "文档：https://docs.openclaw.ai/tools/web",
      ].join("\n"),
      "网页搜索",
    );
    return applySearchKey(config, choice, ref);
  }

  const keyInput = await prompter.text({
    message: keyConfigured
      ? `${entry.label} API Key（留空则保留当前值）`
      : envAvailable
        ? `${entry.label} API Key（留空则使用环境变量）`
        : `${entry.label} API Key`,
    placeholder: keyConfigured ? "留空则保留当前值" : entry.placeholder,
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
      "当前未存储 API Key，在提供密钥之前 `web_search` 无法使用。",
      `获取密钥：${entry.signupUrl}`,
      "文档：https://docs.openclaw.ai/tools/web",
    ].join("\n"),
    "网页搜索",
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
