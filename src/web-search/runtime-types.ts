import type { OpenClawConfig } from "../config/types.openclaw.js";
import type {
  PluginWebSearchProviderEntry,
  WebSearchProviderToolDefinition,
} from "../plugins/web-provider-types.js";
import type { RuntimeWebSearchMetadata } from "../secrets/runtime-web-tools.types.js";

/**
 * Web搜索配置类型
 * 从OpenClawConfig的工具配置中提取搜索配置
 */
type WebSearchConfig = NonNullable<OpenClawConfig["tools"]>["web"] extends infer Web
  ? Web extends { search?: infer Search }
    ? Search
    : undefined
  : undefined;

/**
 * 解析Web搜索定义的参数
 */
export type ResolveWebSearchDefinitionParams = {
  config?: OpenClawConfig;
  sandboxed?: boolean;
  runtimeWebSearch?: RuntimeWebSearchMetadata;
  providerId?: string;
  preferRuntimeProviders?: boolean;
};

/**
 * 运行Web搜索的参数
 */
export type RunWebSearchParams = ResolveWebSearchDefinitionParams & {
  args: Record<string, unknown>;
};

/**
 * 运行Web搜索的结果
 */
export type RunWebSearchResult = {
  provider: string;
  result: Record<string, unknown>;
};

/**
 * 列出Web搜索提供商的参数
 */
export type ListWebSearchProvidersParams = {
  config?: OpenClawConfig;
};

/**
 * 运行时Web搜索提供商条目
 */
export type RuntimeWebSearchProviderEntry = PluginWebSearchProviderEntry;

/**
 * 运行时Web搜索工具定义
 */
export type RuntimeWebSearchToolDefinition = WebSearchProviderToolDefinition;

/**
 * 运行时Web搜索配置
 */
export type RuntimeWebSearchConfig = WebSearchConfig;
