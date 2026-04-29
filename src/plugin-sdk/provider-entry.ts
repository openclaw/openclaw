/**
 * Provider 插件入口模块
 * 
 * 本模块提供了定义单一 Provider 插件的辅助函数，用于注册 Provider 插件到 OpenClaw 系统。
 * Provider 插件负责管理与 AI 模型提供商的连接、认证和通信。
 */

// 从父级目录导入 Provider API 密钥认证方法
import { createProviderApiKeyAuthMethod } from "../plugins/provider-api-key-auth.js";
// 导入 Provider 插件相关的类型定义
import type {
  ProviderPlugin,
  ProviderCatalogContext,
  ProviderCatalogResult,
  ProviderPluginCatalog,
  ProviderPluginWizardSetup,
} from "../plugins/types.js";
// 导入插件入口定义函数
import { definePluginEntry } from "./plugin-entry.js";
// 导入插件 API 和配置 schema 类型
import type {
  OpenClawPluginApi,
  OpenClawPluginConfigSchema,
  OpenClawPluginDefinition,
} from "./plugin-entry.js";
// 导入单一 Provider API 密钥目录构建器
import { buildSingleProviderApiKeyCatalog } from "./provider-catalog-shared.js";

/**
 * API 密钥认证方法选项的类型别名
 * 提取自 createProviderApiKeyAuthMethod 函数的参数类型
 */
type ApiKeyAuthMethodOptions = Parameters<typeof createProviderApiKeyAuthMethod>[0];

/**
 * 单一 Provider 插件 API 密钥认证选项
 * 省略了 providerId、expectedProviders 和 wizard 字段，由插件自动处理
 */
export type SingleProviderPluginApiKeyAuthOptions = Omit<
  ApiKeyAuthMethodOptions,
  "providerId" | "expectedProviders" | "wizard"
> & {
  // 可选的提供商 ID 数组，用于多提供商场景
  expectedProviders?: string[];
  // 向导设置，可为 false（禁用）或 ProviderPluginWizardSetup 配置对象
  wizard?: false | ProviderPluginWizardSetup;
};

/**
 * 单一 Provider 插件目录选项
 * 支持两种构建方式：动态构建（buildProvider）或静态运行（run）
 */
export type SingleProviderPluginCatalogOptions =
  // 动态构建模式：提供 buildProvider 函数来动态生成目录
  | {
      buildProvider: Parameters<typeof buildSingleProviderApiKeyCatalog>[0]["buildProvider"];
      buildStaticProvider?: Parameters<typeof buildSingleProviderApiKeyCatalog>[0]["buildProvider"];
      // 是否允许显式指定基础 URL
      allowExplicitBaseUrl?: boolean;
      // run 和 staticRun 必须为 never
      run?: never;
      order?: never;
      staticRun?: never;
    }
  // 静态运行模式：提供直接的 run 函数
  | {
      run: ProviderPluginCatalog["run"];
      staticRun?: ProviderPluginCatalog["run"];
      order?: ProviderPluginCatalog["order"];
      buildProvider?: never;
      buildStaticProvider?: never;
      allowExplicitBaseUrl?: never;
    };

/**
 * 单一 Provider 插件选项
 * 定义了一个完整的 Provider 插件所需的所有配置
 */
export type SingleProviderPluginOptions = {
  // 插件唯一标识符
  id: string;
  // 插件显示名称
  name: string;
  // 插件描述信息
  description: string;
  // 插件类型（可选）
  kind?: OpenClawPluginDefinition["kind"];
  // 插件配置 schema，用于配置验证
  configSchema?: OpenClawPluginConfigSchema | (() => OpenClawPluginConfigSchema);
  // Provider 配置（可选）
  provider?: {
    // Provider ID，默认使用插件 ID
    id?: string;
    // Provider 显示标签
    label: string;
    // 文档路径
    docsPath: string;
    // Provider 别名列表
    aliases?: string[];
    // 需要的环境变量列表
    envVars?: string[];
    // 认证方法配置
    auth?: SingleProviderPluginApiKeyAuthOptions[];
    // 目录构建配置
    catalog: SingleProviderPluginCatalogOptions;
    // 省略 ProviderPlugin 中已单独处理的字段
  } & Omit<
    ProviderPlugin,
    "id" | "label" | "docsPath" | "aliases" | "envVars" | "auth" | "catalog" | "staticCatalog"
  >;
  // 插件注册回调函数
  register?: (api: OpenClawPluginApi) => void;
};

/**
 * 解析向导设置
 * 根据认证选项构建完整的向导配置对象
 * 
 * @param params - 包含 providerId、providerLabel 和 auth 配置的对象
 * @returns 解析后的向导设置，或 undefined（如果向导被禁用）
 */
function resolveWizardSetup(params: {
  providerId: string;
  providerLabel: string;
  auth: SingleProviderPluginApiKeyAuthOptions;
}): ProviderPluginWizardSetup | undefined {
  // 如果 wizard 显式设置为 false，则返回 undefined
  if (params.auth.wizard === false) {
    return undefined;
  }
  // 使用现有向导配置或空对象
  const wizard = params.auth.wizard ?? {};
  // 获取方法 ID 并去除空白
  const methodId = params.auth.methodId.trim();
  // 构建并返回向导配置
  return {
    // 选择项 ID，默认为 providerId-methodId 格式
    choiceId: wizard.choiceId ?? `${params.providerId}-${methodId}`,
    // 选择项标签，默认为认证方法标签
    choiceLabel: wizard.choiceLabel ?? params.auth.label,
    // 如果有选择提示，则添加
    ...(wizard.choiceHint ? { choiceHint: wizard.choiceHint } : {}),
    // 分组 ID，默认为 providerId
    groupId: wizard.groupId ?? params.providerId,
    // 分组标签，默认为 provider 标签
    groupLabel: wizard.groupLabel ?? params.providerLabel,
    // 添加分组提示（如果有）
    ...((wizard.groupHint ?? params.auth.hint)
      ? { groupHint: wizard.groupHint ?? params.auth.hint }
      : {}),
    // 方法 ID
    methodId,
    // 如果有 onboarding scopes，则添加
    ...(wizard.onboardingScopes ? { onboardingScopes: wizard.onboardingScopes } : {}),
    // 如果有模型允许列表，则添加
    ...(wizard.modelAllowlist ? { modelAllowlist: wizard.modelAllowlist } : {}),
  };
}

/**
 * 解析环境变量列表
 * 合并来自 provider 和 auth 配置中的所有环境变量
 * 
 * @param params - 包含 envVars 和 auth 配置的对象
 * @returns 去重后的环境变量列表，或 undefined（如果没有环境变量）
 */
function resolveEnvVars(params: {
  envVars?: string[];
  auth?: SingleProviderPluginApiKeyAuthOptions[];
}): string[] | undefined {
  // 合并 provider 和 auth 中的所有环境变量
  const combined = [
    ...(params.envVars ?? []),
    // 从 auth 配置中提取 envVar，并过滤掉空值
    ...(params.auth ?? []).map((entry) => entry.envVar).filter(Boolean),
  ]
    // 去除每项的空白字符
    .map((value) => value.trim())
    // 过滤空字符串
    .filter(Boolean);
  // 如果有内容，返回去重后的列表；否则返回 undefined
  return combined.length > 0 ? [...new Set(combined)] : undefined;
}

/**
 * 定义单一 Provider 插件入口
 * 
 * 这是一个便捷函数，用于创建注册单个 AI 模型提供商的插件。
 * 它封装了 definePluginEntry 的常见模式，提供了 Provider 特定的注册逻辑。
 * 
 * @param options - 插件选项，包含 id、name、description、provider 配置等
 * @returns 符合 OpenClaw 插件定义格式的对象
 * 
 * @example
 * ```typescript
 * defineSingleProviderPluginEntry({
 *   id: "openai",
 *   name: "OpenAI",
 *   description: "OpenAI GPT models provider",
 *   provider: {
 *     label: "OpenAI",
 *     docsPath: "/docs/providers/openai",
 *     envVars: ["OPENAI_API_KEY"],
 *     auth: [{ methodId: "api-key", envVar: "OPENAI_API_KEY" }],
 *     catalog: {
 *       buildProvider: async (ctx) => ({ ... })
 *     }
 *   }
 * });
 * ```
 */
export function defineSingleProviderPluginEntry(options: SingleProviderPluginOptions) {
  // 调用底层 definePluginEntry 函数
  return definePluginEntry({
    id: options.id,
    name: options.name,
    description: options.description,
    // 如果指定了 kind，则传递
    ...(options.kind ? { kind: options.kind } : {}),
    // 如果指定了 configSchema，则传递
    ...(options.configSchema ? { configSchema: options.configSchema } : {}),
    // 注册函数
    register(api) {
      const provider = options.provider;
      // 如果提供了 provider 配置
      if (provider) {
        // 确定 provider ID，默认使用插件 ID
        const providerId = provider.id ?? options.id;
        // 解析环境变量列表
        const envVars = resolveEnvVars({
          envVars: provider.envVars,
          auth: provider.auth,
        });
        // 处理认证方法配置
        const auth = (provider.auth ?? []).map((entry) => {
          // 提取 wizard 配置（稍后单独处理）
          const { wizard: _wizard, ...authParams } = entry;
          // 解析向导设置
          const wizard = resolveWizardSetup({
            providerId,
            providerLabel: provider.label,
            auth: entry,
          });
          // 创建认证方法
          return createProviderApiKeyAuthMethod({
            ...authParams,
            providerId,
            // 如果没有指定 expectedProviders，默认使用 providerId
            expectedProviders: entry.expectedProviders ?? [providerId],
            // 如果有向导设置，则添加
            ...(wizard ? { wizard } : {}),
          });
        });

        // 处理目录配置
        let catalog: ProviderPluginCatalog;
        if ("run" in provider.catalog) {
          // 静态运行模式
          const catalogRun = provider.catalog.run;
          catalog = {
            order: provider.catalog.order ?? "simple",
            run: catalogRun!,
          };
        } else {
          // 动态构建模式
          const buildProvider = provider.catalog.buildProvider;
          catalog = {
            order: "simple",
            // 使用 buildSingleProviderApiKeyCatalog 构建目录
            run: (ctx: ProviderCatalogContext): Promise<ProviderCatalogResult> =>
              buildSingleProviderApiKeyCatalog({
                ctx,
                providerId,
                buildProvider,
                // 如果允许显式基础 URL，则传递
                ...(provider.catalog.allowExplicitBaseUrl ? { allowExplicitBaseUrl: true } : {}),
              }),
          };
        }

        // 处理静态目录配置（可选）
        const staticCatalog: ProviderPluginCatalog | undefined =
          "run" in provider.catalog
            ? provider.catalog.staticRun
              ? {
                  order: provider.catalog.order ?? "simple",
                  run: provider.catalog.staticRun,
                }
              : undefined
            : provider.catalog.buildStaticProvider
              ? {
                  order: "simple",
                  run: async () => ({
                    provider: await provider.catalog.buildStaticProvider!(),
                  }),
                }
              : undefined;

        // 注册 Provider 到 API
        api.registerProvider({
          id: providerId,
          label: provider.label,
          docsPath: provider.docsPath,
          // 如果有别名，则添加
          ...(provider.aliases ? { aliases: provider.aliases } : {}),
          // 如果有环境变量，则添加
          ...(envVars ? { envVars } : {}),
          auth,
          catalog,
          // 如果有静态目录，则添加
          ...(staticCatalog ? { staticCatalog } : {}),
          // 添加 provider 中未单独处理的剩余字段
          ...Object.fromEntries(
            Object.entries(provider).filter(
              ([key]) =>
                ![
                  "id",
                  "label",
                  "docsPath",
                  "aliases",
                  "envVars",
                  "auth",
                  "catalog",
                  "staticCatalog",
                ].includes(key),
            ),
          ),
        });
      }
      // 调用用户提供的注册回调
      options.register?.(api);
    },
  });
}
