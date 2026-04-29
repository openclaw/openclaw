// 引入认证配置存储类型
import type { AuthProfileStore } from "../agents/auth-profiles/types.js";
// 引入 OpenClaw 配置类型
import type { OpenClawConfig } from "../config/types.openclaw.js";
// 引入媒体规范化条目类型
import type { MediaNormalizationEntry } from "../media-generation/normalization.types.js";

// 已生成图像资源的类型
export type GeneratedImageAsset = {
  buffer: Buffer;           // 图像数据缓冲区
  mimeType: string;        // MIME 类型
  fileName?: string;       // 可选的文件名
  revisedPrompt?: string;   // 修订后的提示词（某些提供商会返回）
  metadata?: Record<string, unknown>; // 额外元数据
};

// 图像生成分辨率选项
export type ImageGenerationResolution = "1K" | "2K" | "4K";

// 图像生成质量选项
export type ImageGenerationQuality = "low" | "medium" | "high" | "auto";

// 图像生成输出格式选项
export type ImageGenerationOutputFormat = "png" | "jpeg" | "webp";

// 图像生成背景选项
export type ImageGenerationBackground = "transparent" | "opaque" | "auto";

// OpenAI 兼容的背景选项类型别名
export type ImageGenerationOpenAIBackground = ImageGenerationBackground;

// OpenAI 兼容的审核选项
export type ImageGenerationOpenAIModeration = "low" | "auto";

// OpenAI 兼容的生成选项
export type ImageGenerationOpenAIOptions = {
  background?: ImageGenerationOpenAIBackground;   // 背景设置
  moderation?: ImageGenerationOpenAIModeration;   // 审核级别
  outputCompression?: number;                     // 输出压缩率
  user?: string;                                  // 用户标识符
};

// 图像生成提供商特定选项联合类型
export type ImageGenerationProviderOptions = {
  openai?: ImageGenerationOpenAIOptions; // OpenAI 格式选项
};

// 被忽略的覆盖选项的键类型
export type ImageGenerationIgnoredOverrideKey =
  | "size"         // 尺寸
  | "aspectRatio"  // 宽高比
  | "resolution"   // 分辨率
  | "quality"      // 质量
  | "outputFormat" // 输出格式
  | "background";  // 背景

// 被忽略的覆盖选项条目
export type ImageGenerationIgnoredOverride = {
  key: ImageGenerationIgnoredOverrideKey; // 选项键
  value: string;                           // 被忽略的值
};

// 图像生成源图像（用于参考图像）
export type ImageGenerationSourceImage = {
  buffer: Buffer;                         // 图像数据
  mimeType: string;                        // MIME 类型
  fileName?: string;                       // 可选文件名
  metadata?: Record<string, unknown>;      // 额外元数据
};

// 图像生成提供商配置上下文
export type ImageGenerationProviderConfiguredContext = {
  cfg?: OpenClawConfig;   // OpenClaw 配置
  agentDir?: string;     // Agent 目录
};

// 图像生成请求类型
export type ImageGenerationRequest = {
  provider: string;                       // 提供商标识符
  model: string;                           // 模型标识符
  prompt: string;                          // 生成提示词
  cfg: OpenClawConfig;                     // OpenClaw 配置
  agentDir?: string;                       // Agent 目录
  authStore?: AuthProfileStore;            // 认证存储
  timeoutMs?: number;                      // 超时时间（毫秒）
  count?: number;                          // 生成数量
  size?: string;                           // 图像尺寸
  aspectRatio?: string;                    // 宽高比
  resolution?: ImageGenerationResolution;   // 分辨率
  quality?: ImageGenerationQuality;         // 质量
  outputFormat?: ImageGenerationOutputFormat; // 输出格式
  background?: ImageGenerationBackground;    // 背景
  inputImages?: ImageGenerationSourceImage[]; // 参考图像列表
  providerOptions?: ImageGenerationProviderOptions; // 提供商特定选项
};

// 图像生成结果类型
export type ImageGenerationResult = {
  images: GeneratedImageAsset[];           // 生成的图像数组
  model?: string;                          // 实际使用的模型
  metadata?: Record<string, unknown>;       // 额外元数据
};

// 图像生成模式能力
export type ImageGenerationModeCapabilities = {
  maxCount?: number;                       // 最大生成数量
  supportsSize?: boolean;                   // 是否支持尺寸
  supportsAspectRatio?: boolean;            // 是否支持宽高比
  supportsResolution?: boolean;             // 是否支持分辨率
};

// 图像生成编辑能力
export type ImageGenerationEditCapabilities = ImageGenerationModeCapabilities & {
  enabled: boolean;                         // 是否启用
  maxInputImages?: number;                  // 最大输入图像数量
};

// 图像生成几何能力（尺寸和宽高比）
export type ImageGenerationGeometryCapabilities = {
  sizes?: string[];                         // 支持的尺寸列表
  aspectRatios?: string[];                  // 支持的宽高比列表
  resolutions?: ImageGenerationResolution[]; // 支持的分辨率列表
};

// 图像生成输出能力（质量和格式）
export type ImageGenerationOutputCapabilities = {
  qualities?: ImageGenerationQuality[];      // 支持的质量选项
  formats?: ImageGenerationOutputFormat[];   // 支持的格式
  backgrounds?: ImageGenerationBackground[];  // 支持的背景选项
};

// 图像生成规范化结果
export type ImageGenerationNormalization = {
  size?: MediaNormalizationEntry<string>;                                   // 尺寸规范化
  aspectRatio?: MediaNormalizationEntry<string>;                           // 宽高比规范化
  resolution?: MediaNormalizationEntry<ImageGenerationResolution>;         // 分辨率规范化
};

// 图像生成提供商能力
export type ImageGenerationProviderCapabilities = {
  generate: ImageGenerationModeCapabilities;   // 生成模式能力
  edit: ImageGenerationEditCapabilities;       // 编辑能力
  geometry?: ImageGenerationGeometryCapabilities; // 几何能力（可选）
  output?: ImageGenerationOutputCapabilities; // 输出能力（可选）
};

// 图像生成提供商接口
export type ImageGenerationProvider = {
  id: string;                                    // 提供商唯一标识符
  aliases?: string[];                           // 别名列表
  label?: string;                                // 显示标签
  defaultModel?: string;                         // 默认模型
  models?: string[];                             // 支持的模型列表
  capabilities: ImageGenerationProviderCapabilities; // 提供商能力
  // 检查提供商是否已配置
  isConfigured?: (ctx: ImageGenerationProviderConfiguredContext) => boolean;
  // 生成图像的核心方法
  generateImage: (req: ImageGenerationRequest) => Promise<ImageGenerationResult>;
};
