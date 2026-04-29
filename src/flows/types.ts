// 流程文档链接类型
export type FlowDocsLink = {
  path: string;  // 文档路径
  label?: string;  // 可选的文档标签
};

// 流程贡献类型：渠道、核心、提供商、搜索
export type FlowContributionKind = "channel" | "core" | "provider" | "search";

// 流程贡献表面类型：认证选择、健康检查、模型选择、设置
export type FlowContributionSurface = "auth-choice" | "health" | "model-picker" | "setup";

// 流程选项组类型
export type FlowOptionGroup = {
  id: string;  // 组 ID
  label: string;  // 组标签
  hint?: string;  // 可选提示
};

// 流程选项类型
export type FlowOption<Value extends string = string> = {
  value: Value;  // 选项值
  label: string;  // 选项标签
  hint?: string;  // 可选提示
  group?: FlowOptionGroup;  // 可选所属组
  docs?: FlowDocsLink;  // 可选文档链接
  assistantPriority?: number;  // 助手优先级
  assistantVisibility?: "visible" | "manual-only";  // 助手可见性
};

// 流程贡献类型
export type FlowContribution<Value extends string = string> = {
  id: string;  // 贡献 ID
  kind: FlowContributionKind;  // 贡献类型
  surface: FlowContributionSurface;  // 表面类型
  option: FlowOption<Value>;  // 选项
  source?: string;  // 来源
};

// 按标签对流程贡献进行排序
// contributions: 要排序的贡献数组
export function sortFlowContributionsByLabel<T extends FlowContribution>(
  contributions: readonly T[],
): T[] {
  return [...contributions].toSorted(
    (left, right) =>
      // 首先按标签比较
      left.option.label.localeCompare(right.option.label) ||
      // 然后按值比较
      left.option.value.localeCompare(right.option.value),
  );
}
