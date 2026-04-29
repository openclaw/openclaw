// OpenClaw 配置类型
import type { OpenClawConfig } from "../config/types.openclaw.js";
// 插件配置状态规范化
import { normalizePluginsConfig, resolveEffectiveEnableState } from "../plugins/config-state.js";
// 提供商认证选择解析
import { resolveManifestProviderAuthChoices } from "../plugins/provider-auth-choices.js";
// 提供商安装目录条目解析
import { resolveProviderInstallCatalogEntries } from "../plugins/provider-install-catalog.js";
// 流程类型导入
import type { FlowContribution, FlowOption } from "./types.js";
// 流程贡献排序
import { sortFlowContributionsByLabel } from "./types.js";

// 提供商流程作用域类型：文本推理或图像生成
export type ProviderFlowScope = "text-inference" | "image-generation";

// 默认提供商流程作用域为文本推理
const DEFAULT_PROVIDER_FLOW_SCOPE: ProviderFlowScope = "text-inference";

// 提供商设置流程选项类型
export type ProviderSetupFlowOption = FlowOption & {
  onboardingScopes?: ProviderFlowScope[];  // 入门作用域
};

// 提供商模型选择流程条目类型
export type ProviderModelPickerFlowEntry = FlowOption;

// 提供商设置流程贡献类型
export type ProviderSetupFlowContribution = FlowContribution & {
  kind: "provider";  // 类型为提供商
  surface: "setup";  // 表面为设置
  providerId: string;  // 提供商 ID
  pluginId?: string;  // 插件 ID
  option: ProviderSetupFlowOption;  // 选项
  onboardingScopes?: ProviderFlowScope[];  // 入门作用域
  source: "manifest" | "install-catalog";  // 来源
};

// 检查是否包含特定作用域
function includesProviderFlowScope(
  scopes: readonly ProviderFlowScope[] | undefined,
  scope: ProviderFlowScope,
): boolean {
  return scopes ? scopes.includes(scope) : scope === DEFAULT_PROVIDER_FLOW_SCOPE;
}

// 解析安装目录提供商设置流程贡献
function resolveInstallCatalogProviderSetupFlowContributions(params?: {
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  scope?: ProviderFlowScope;
}): ProviderSetupFlowContribution[] {
  const scope = params?.scope ?? DEFAULT_PROVIDER_FLOW_SCOPE;
  // 规范化插件配置
  const normalizedPluginsConfig = normalizePluginsConfig(params?.config?.plugins);
  // 解析提供商安装目录条目
  return resolveProviderInstallCatalogEntries({
    ...params,
    includeUntrustedWorkspacePlugins: false,  // 不包含不受信任的工作区插件
  })
    // 过滤符合作用域和启用状态的条目
    .filter(
      (entry) =>
        includesProviderFlowScope(entry.onboardingScopes, scope) &&
        resolveEffectiveEnableState({
          id: entry.pluginId,
          origin: entry.origin,
          config: normalizedPluginsConfig,
          rootConfig: params?.config,
          enabledByDefault: true,  // 默认启用
        }).enabled,
    )
    // 映射为流程贡献
    .map((entry) => {
      const groupId = entry.groupId ?? entry.providerId;  // 组 ID
      const groupLabel = entry.groupLabel ?? entry.label;  // 组标签
      return Object.assign(
        {
          id: `provider:setup:${entry.choiceId}`,
          kind: `provider` as const,
          surface: `setup` as const,
          providerId: entry.providerId,
          pluginId: entry.pluginId,
          option: {
            value: entry.choiceId,
            label: entry.choiceLabel,
            // 添加可选提示
            ...(entry.choiceHint ? { hint: entry.choiceHint } : {}),
            // 添加可选的助手优先级
            ...(entry.assistantPriority !== undefined
              ? { assistantPriority: entry.assistantPriority }
              : {}),
            // 添加可选的助手可见性
            ...(entry.assistantVisibility
              ? { assistantVisibility: entry.assistantVisibility }
              : {}),
            group: {
              id: groupId,
              label: groupLabel,
              // 添加可选的组提示
              ...(entry.groupHint ? { hint: entry.groupHint } : {}),
            },
          },
        },
        // 添加可选的入门作用域
        entry.onboardingScopes ? { onboardingScopes: [...entry.onboardingScopes] } : {},
        { source: `install-catalog` as const },
      );
    });
}

// 解析清单提供商设置流程贡献
function resolveManifestProviderSetupFlowContributions(params?: {
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  scope?: ProviderFlowScope;
}): ProviderSetupFlowContribution[] {
  const scope = params?.scope ?? DEFAULT_PROVIDER_FLOW_SCOPE;
  // 解析清单提供商认证选择
  return resolveManifestProviderAuthChoices({
    ...params,
    includeUntrustedWorkspacePlugins: false,  // 不包含不受信任的工作区插件
  })
    // 过滤符合作用域的选择
    .filter((choice) => includesProviderFlowScope(choice.onboardingScopes, scope))
    // 映射为流程贡献
    .map((choice) => {
      const groupId = choice.groupId ?? choice.providerId;  // 组 ID
      const groupLabel = choice.groupLabel ?? choice.choiceLabel;  // 组标签
      return Object.assign(
        {
          id: `provider:setup:${choice.choiceId}`,
          kind: `provider` as const,
          surface: `setup` as const,
          providerId: choice.providerId,
          pluginId: choice.pluginId,
          option: {
            value: choice.choiceId,
            label: choice.choiceLabel,
            // 添加可选提示
            ...(choice.choiceHint ? { hint: choice.choiceHint } : {}),
            // 添加可选的助手优先级
            ...(choice.assistantPriority !== undefined
              ? { assistantPriority: choice.assistantPriority }
              : {}),
            // 添加可选的助手可见性
            ...(choice.assistantVisibility
              ? { assistantVisibility: choice.assistantVisibility }
              : {}),
            group: {
              id: groupId,
              label: groupLabel,
              // 添加可选的组提示
              ...(choice.groupHint ? { hint: choice.groupHint } : {}),
            },
          },
        },
        // 添加可选的入门作用域
        choice.onboardingScopes ? { onboardingScopes: [...choice.onboardingScopes] } : {},
        { source: `manifest` as const },
      );
    });
}

// 解析提供商设置流程贡献（合并清单和安装目录）
export function resolveProviderSetupFlowContributions(params?: {
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  scope?: ProviderFlowScope;
}): ProviderSetupFlowContribution[] {
  const scope = params?.scope ?? DEFAULT_PROVIDER_FLOW_SCOPE;
  // 解析清单贡献
  const manifestContributions = resolveManifestProviderSetupFlowContributions({
    ...params,
    scope,
  });
  // 记录已见过的选项值，避免重复
  const seenOptionValues = new Set(
    manifestContributions.map((contribution) => contribution.option.value),
  );
  // 解析安装目录贡献，排除已见过的
  const installCatalogContributions = resolveInstallCatalogProviderSetupFlowContributions({
    ...params,
    scope,
  }).filter((contribution) => !seenOptionValues.has(contribution.option.value));
  // 合并并排序返回
  return sortFlowContributionsByLabel([...manifestContributions, ...installCatalogContributions]);
}

// 导出作用域包含检查函数
export { includesProviderFlowScope };
