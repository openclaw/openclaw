import {
  getRuntimeConfigSnapshot,
  getRuntimeConfigSourceSnapshot,
  selectApplicableRuntimeConfig,
} from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { logVerbose } from "../globals.js";
import type {
  PluginWebSearchProviderEntry,
  WebSearchProviderToolDefinition,
} from "../plugins/web-provider-types.js";
import { resolvePluginWebSearchProviders } from "../plugins/web-search-providers.runtime.js";
import { resolveRuntimeWebSearchProviders } from "../plugins/web-search-providers.runtime.js";
import { sortWebSearchProvidersForAutoDetect } from "../plugins/web-search-providers.shared.js";
import { getActiveRuntimeWebToolsMetadata } from "../secrets/runtime-web-tools-state.js";
import type { RuntimeWebSearchMetadata } from "../secrets/runtime-web-tools.types.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
} from "../shared/string-coerce.js";
import {
  hasWebProviderEntryCredential,
  providerRequiresCredential,
  readWebProviderEnvValue,
  resolveWebProviderConfig,
  resolveWebProviderDefinition,
} from "../web/provider-runtime-shared.js";
import type {
  ResolveWebSearchDefinitionParams,
  RunWebSearchParams,
  RunWebSearchResult,
  RuntimeWebSearchConfig as WebSearchConfig,
} from "./runtime-types.js";

/**
 * 导出Web搜索相关类型
 */
export type {
  ListWebSearchProvidersParams,
  ResolveWebSearchDefinitionParams,
  RunWebSearchParams,
  RunWebSearchResult,
  RuntimeWebSearchConfig,
  RuntimeWebSearchProviderEntry,
  RuntimeWebSearchToolDefinition,
} from "./runtime-types.js";

/**
 * 解析搜索配置
 * @param cfg - OpenClaw配置
 * @returns Web搜索配置
 */
function resolveSearchConfig(cfg?: OpenClawConfig): WebSearchConfig {
  return resolveWebProviderConfig(cfg, "search") as NonNullable<WebSearchConfig> | undefined;
}

/**
 * 解析Web搜索运行时配置
 * @param config - 可选的配置
 * @returns 运行时配置或undefined
 */
function resolveWebSearchRuntimeConfig(config?: OpenClawConfig): OpenClawConfig | undefined {
  return selectApplicableRuntimeConfig({
    inputConfig: config,
    runtimeConfig: getRuntimeConfigSnapshot(),
    runtimeSourceConfig: getRuntimeConfigSourceSnapshot(),
  });
}

/**
 * 解析Web搜索是否启用
 * @param params - 搜索配置和沙盒标志
 * @returns 是否启用
 */
export function resolveWebSearchEnabled(params: {
  search?: WebSearchConfig;
  sandboxed?: boolean;
}): boolean {
  if (typeof params.search?.enabled === "boolean") {
    return params.search.enabled;
  }
  if (params.sandboxed) {
    return true;
  }
  return true;
}

/**
 * 检查条目是否有凭证
 * @param provider - 提供商条目
 * @param config - OpenClaw配置
 * @param search - 搜索配置
 * @returns 是否有凭证
 */
function hasEntryCredential(
  provider: Pick<
    PluginWebSearchProviderEntry,
    | "credentialPath"
    | "id"
    | "envVars"
    | "getConfiguredCredentialValue"
    | "getCredentialValue"
    | "requiresCredential"
  >,
  config: OpenClawConfig | undefined,
  search: WebSearchConfig | undefined,
): boolean {
  return hasWebProviderEntryCredential({
    provider,
    config,
    toolConfig: search as Record<string, unknown> | undefined,
    resolveRawValue: ({ provider: currentProvider, config: currentConfig }) =>
      currentProvider.getConfiguredCredentialValue?.(currentConfig),
    resolveEnvValue: ({ provider: currentProvider, configuredEnvVarId }) =>
      (configuredEnvVarId ? readWebProviderEnvValue([configuredEnvVarId]) : undefined) ??
      readWebProviderEnvValue(currentProvider.envVars),
  });
}

/**
 * 检查Web搜索提供商是否已配置
 * @param params - 提供商和配置
 * @returns 是否已配置
 */
export function isWebSearchProviderConfigured(params: {
  provider: Pick<
    PluginWebSearchProviderEntry,
    | "credentialPath"
    | "id"
    | "envVars"
    | "getConfiguredCredentialValue"
    | "getCredentialValue"
    | "requiresCredential"
  >;
  config?: OpenClawConfig;
}): boolean {
  const config = resolveWebSearchRuntimeConfig(params.config);
  return hasEntryCredential(params.provider, config, resolveSearchConfig(config));
}

/**
 * 列出所有Web搜索提供商
 * @param params - 可选配置
 * @returns 提供商条目数组
 */
export function listWebSearchProviders(params?: {
  config?: OpenClawConfig;
}): PluginWebSearchProviderEntry[] {
  const config = resolveWebSearchRuntimeConfig(params?.config);
  return resolveRuntimeWebSearchProviders({
    config,
    bundledAllowlistCompat: true,
  });
}

/**
 * 列出已配置的Web搜索提供商
 * @param params - 可选配置
 * @returns 提供商条目数组
 */
export function listConfiguredWebSearchProviders(params?: {
  config?: OpenClawConfig;
}): PluginWebSearchProviderEntry[] {
  const config = resolveWebSearchRuntimeConfig(params?.config);
  return resolvePluginWebSearchProviders({
    config,
    bundledAllowlistCompat: true,
  });
}

/**
 * 解析Web搜索提供商ID
 * @param params - 搜索配置、配置和提供商列表
 * @returns 提供商ID
 */
export function resolveWebSearchProviderId(params: {
  search?: WebSearchConfig;
  config?: OpenClawConfig;
  providers?: PluginWebSearchProviderEntry[];
}): string {
  const config = resolveWebSearchRuntimeConfig(params.config);
  const search = params.search ?? resolveSearchConfig(config);
  const providers = sortWebSearchProvidersForAutoDetect(
    params.providers ??
      resolvePluginWebSearchProviders({
        config,
        bundledAllowlistCompat: true,
        origin: "bundled",
      }),
  );
  const raw =
    search && "provider" in search ? normalizeLowercaseStringOrEmpty(search.provider) : "";

  if (raw) {
    const explicit = providers.find((provider) => provider.id === raw);
    if (explicit) {
      return explicit.id;
    }
  }

  if (!raw) {
    let keylessFallbackProviderId = "";
    for (const provider of providers) {
      if (!providerRequiresCredential(provider)) {
        keylessFallbackProviderId ||= provider.id;
        continue;
      }
      if (!hasEntryCredential(provider, config, search)) {
        continue;
      }
      logVerbose(
        `web_search: no provider configured, auto-detected "${provider.id}" from available API keys`,
      );
      return provider.id;
    }
    if (keylessFallbackProviderId) {
      logVerbose(
        `web_search: no provider configured and no credentials found, falling back to keyless provider "${keylessFallbackProviderId}"`,
      );
      return keylessFallbackProviderId;
    }
  }

  return providers[0]?.id ?? "";
}

/**
 * 解析Web搜索定义
 * @param options - 解析选项
 * @returns 提供商和定义或null
 */
export function resolveWebSearchDefinition(
  options?: ResolveWebSearchDefinitionParams,
): { provider: PluginWebSearchProviderEntry; definition: WebSearchProviderToolDefinition } | null {
  const config = resolveWebSearchRuntimeConfig(options?.config);
  const search = resolveSearchConfig(config);
  const runtimeWebSearch = options?.runtimeWebSearch ?? getActiveRuntimeWebToolsMetadata()?.search;
  const providers = sortWebSearchProvidersForAutoDetect(
    options?.preferRuntimeProviders
      ? resolveRuntimeWebSearchProviders({
          config,
          bundledAllowlistCompat: true,
        })
      : resolvePluginWebSearchProviders({
          config,
          bundledAllowlistCompat: true,
          origin: "bundled",
        }),
  );
  return resolveWebProviderDefinition({
    config,
    toolConfig: search as Record<string, unknown> | undefined,
    runtimeMetadata: runtimeWebSearch,
    sandboxed: options?.sandboxed,
    providerId: options?.providerId,
    providers,
    resolveEnabled: ({ toolConfig, sandboxed }) =>
      resolveWebSearchEnabled({
        search: toolConfig as WebSearchConfig | undefined,
        sandboxed,
      }),
    resolveAutoProviderId: ({ config, toolConfig, providers }) =>
      resolveWebSearchProviderId({
        config,
        search: toolConfig as WebSearchConfig | undefined,
        providers,
      }),
    resolveFallbackProviderId: ({ config, toolConfig, providers }) =>
      resolveWebSearchProviderId({
        config,
        search: toolConfig as WebSearchConfig | undefined,
        providers,
      }) || providers[0]?.id,
    createTool: ({ provider, config, toolConfig, runtimeMetadata }) =>
      provider.createTool({
        config,
        searchConfig: toolConfig,
        runtimeMetadata,
      }),
  });
}

/**
 * 解析Web搜索候选提供商
 * @param options - 解析选项
 * @returns 候选提供商数组
 */
function resolveWebSearchCandidates(
  options?: ResolveWebSearchDefinitionParams,
): PluginWebSearchProviderEntry[] {
  const config = resolveWebSearchRuntimeConfig(options?.config);
  const search = resolveSearchConfig(config);
  const runtimeWebSearch = options?.runtimeWebSearch ?? getActiveRuntimeWebToolsMetadata()?.search;
  if (!resolveWebSearchEnabled({ search, sandboxed: options?.sandboxed })) {
    return [];
  }

  const providers = sortWebSearchProvidersForAutoDetect(
    options?.preferRuntimeProviders
      ? resolveRuntimeWebSearchProviders({
          config,
          bundledAllowlistCompat: true,
        })
      : resolvePluginWebSearchProviders({
          config,
          bundledAllowlistCompat: true,
          origin: "bundled",
        }),
  ).filter(Boolean);
  if (providers.length === 0) {
    return [];
  }

  const preferredIds = [
    options?.providerId,
    runtimeWebSearch?.selectedProvider,
    runtimeWebSearch?.providerConfigured,
    resolveWebSearchProviderId({ config, search, providers }),
  ].filter(
    (value, index, array): value is string => Boolean(value) && array.indexOf(value) === index,
  );

  const explicitProviderId = options?.providerId?.trim();
  if (explicitProviderId && !providers.some((entry) => entry.id === explicitProviderId)) {
    throw new Error(`Unknown web_search provider "${explicitProviderId}".`);
  }

  const orderedProviders = [
    ...preferredIds
      .map((id) => providers.find((entry) => entry.id === id))
      .filter((entry): entry is PluginWebSearchProviderEntry => Boolean(entry)),
    ...providers.filter((entry) => !preferredIds.includes(entry.id)),
  ];
  return orderedProviders;
}

/**
 * 检查是否有显式的Web搜索选择
 * @param params - 参数
 * @returns 是否有显式选择
 */
function hasExplicitWebSearchSelection(params: {
  search?: WebSearchConfig;
  runtimeWebSearch?: RuntimeWebSearchMetadata;
  providerId?: string;
  providers?: PluginWebSearchProviderEntry[];
}): boolean {
  if (params.providerId?.trim()) {
    return true;
  }
  const availableProviderIds = new Set(
    (params.providers ?? []).map((provider) => normalizeLowercaseStringOrEmpty(provider.id)),
  );
  const configuredProviderId =
    params.search && "provider" in params.search && typeof params.search.provider === "string"
      ? normalizeLowercaseStringOrEmpty(params.search.provider)
      : "";
  if (configuredProviderId && availableProviderIds.has(configuredProviderId)) {
    return true;
  }
  const runtimeConfiguredId = normalizeOptionalLowercaseString(
    params.runtimeWebSearch?.selectedProvider ?? params.runtimeWebSearch?.providerConfigured,
  );
  if (
    params.runtimeWebSearch?.providerSource === "configured" &&
    runtimeConfiguredId &&
    availableProviderIds.has(runtimeConfiguredId)
  ) {
    return true;
  }
  return false;
}

/**
 * 运行Web搜索
 * @param params - 搜索参数
 * @returns 搜索结果
 */
export async function runWebSearch(params: RunWebSearchParams): Promise<RunWebSearchResult> {
  const config = resolveWebSearchRuntimeConfig(params.config);
  const search = resolveSearchConfig(config);
  const runtimeWebSearch = params.runtimeWebSearch ?? getActiveRuntimeWebToolsMetadata()?.search;
  const candidates = resolveWebSearchCandidates({
    ...params,
    config,
    runtimeWebSearch,
    preferRuntimeProviders: params.preferRuntimeProviders ?? true,
  });
  if (candidates.length === 0) {
    throw new Error("web_search is disabled or no provider is available.");
  }
  const allowFallback = !hasExplicitWebSearchSelection({
    search,
    runtimeWebSearch,
    providerId: params.providerId,
    providers: candidates,
  });
  let lastError: unknown;
  let sawUnavailableProvider = false;

  for (const candidate of candidates) {
    try {
      const definition = candidate.createTool({
        config,
        searchConfig: search as Record<string, unknown> | undefined,
        runtimeMetadata: runtimeWebSearch,
      });
      if (!definition) {
        if (!allowFallback) {
          throw new Error(`web_search provider "${candidate.id}" is not available.`);
        }
        sawUnavailableProvider = true;
        continue;
      }
      return {
        provider: candidate.id,
        result: await definition.execute(params.args),
      };
    } catch (error) {
      lastError = error;
      if (!allowFallback) {
        throw error;
      }
    }
  }

  if (sawUnavailableProvider && lastError === undefined) {
    throw new Error("web_search is enabled but no provider is currently available.");
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/**
 * 测试用导出
 */
export const __testing = {
  resolveSearchConfig,
  resolveSearchProvider: resolveWebSearchProviderId,
  resolveWebSearchProviderId,
  resolveWebSearchCandidates,
  hasExplicitWebSearchSelection,
};
