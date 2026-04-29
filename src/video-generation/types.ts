// 引入认证配置存储类型
import type { AuthProfileStore } from "../agents/auth-profiles/types.js";
// 引入 OpenClaw 配置类型
import type { OpenClawConfig } from "../config/types.openclaw.js";
// 引入媒体规范化条目类型
import type { MediaNormalizationEntry } from "../media-generation/normalization.types.js";

// 已生成视频资源的类型
export type GeneratedVideoAsset = {
  /** 原始视频字节，用于本地传递；url 存在时省略 */
  buffer?: Buffer;
  /** 视频的外部 URL（如预签名的云存储 URL）
   * 设置且 buffer 缺失时，传递层可以转发 URL 而非先下载整个视频 */
  url?: string;
  mimeType: string;                         // MIME 类型
  fileName?: string;                       // 可选的文件名
  metadata?: Record<string, unknown>;       // 额外元数据
};

// 视频生成分辨率选项
export type VideoGenerationResolution = "480P" | "720P" | "768P" | "1080P";

/**
 * 参考资产的规范语义角色提示
 * 涵盖了通用的 I2V 词汇和各类型的参考角色
 * 提供商可能接受额外的角色字符串（在调用点用纯字符串扩展 asset.role 类型）
 */
export type VideoGenerationAssetRole =
  | "first_frame"       // 首帧
  | "last_frame"        // 末帧
  | "reference_image"    // 参考图像
  | "reference_video"   // 参考视频
  | "reference_audio";  // 参考音频

// 视频生成源资产类型
export type VideoGenerationSourceAsset = {
  url?: string;           // 资源 URL
  buffer?: Buffer;        // 资源缓冲区
  mimeType?: string;      // MIME 类型
  fileName?: string;      // 文件名
  /**
   * 可选的语义角色提示，转发给提供商
   * 规范值来自 `VideoGenerationAssetRole`；也接受纯字符串用于提供商特定扩展
   * Core 不验证值本身（除了形状）
   */
  // 与 `(string & {})` 的联合在保持规范值自动完成的同时接受任意提供商特定角色字符串
  role?: VideoGenerationAssetRole | (string & {});
  metadata?: Record<string, unknown>; // 额外元数据
};

// 视频生成提供商配置上下文
export type VideoGenerationProviderConfiguredContext = {
  cfg?: OpenClawConfig;   // OpenClaw 配置
  agentDir?: string;     // Agent 目录
};

// 视频生成请求类型
export type VideoGenerationRequest = {
  provider: string;                       // 提供商标识符
  model: string;                           // 模型标识符
  prompt: string;                          // 生成提示词
  cfg: OpenClawConfig;                     // OpenClaw 配置
  agentDir?: string;                       // Agent 目录
  authStore?: AuthProfileStore;            // 认证存储
  timeoutMs?: number;                      // 超时时间（毫秒）
  size?: string;                           // 视频尺寸
  aspectRatio?: string;                    // 宽高比
  resolution?: VideoGenerationResolution;  // 分辨率
  durationSeconds?: number;                // 时长（秒）
  /** 提供商支持时启用输出视频中生成的音频，与 inputAudios（参考音频输入）不同 */
  audio?: boolean;
  watermark?: boolean;                    // 水印
  inputImages?: VideoGenerationSourceAsset[];   // 输入图像列表
  inputVideos?: VideoGenerationSourceAsset[];  // 输入视频列表
  /** 参考音频资产（如背景音乐），每个资产的角色字段按原样转发给提供商 */
  inputAudios?: VideoGenerationSourceAsset[];
  /** 任意提供商特定选项，按原样转发给 provider.generateVideo，Core 不验证或记录内容 */
  providerOptions?: Record<string, unknown>;
};

// 视频生成结果类型
export type VideoGenerationResult = {
  videos: GeneratedVideoAsset[];          // 生成的视频数组
  model?: string;                         // 实际使用的模型
  metadata?: Record<string, unknown>;      // 额外元数据
};

// 被忽略的覆盖选项
export type VideoGenerationIgnoredOverride = {
  key: "size" | "aspectRatio" | "resolution" | "audio" | "watermark"; // 选项键
  value: string | boolean;                  // 被忽略的值
};

// 视频生成模式
export type VideoGenerationMode = "generate" | "imageToVideo" | "videoToVideo";

/**
 * 声明的 `providerOptions` 键的原始类型标签
 * Core 在将代理提供的值转发给提供商之前验证其类型
 * 保持刻意精简——需要更丰富形状的插件应将这些字段排除在类型化契约之外，
 * 并在提供商代码内部重新解释转发的 opaque 值
 */
export type VideoGenerationProviderOptionType = "number" | "boolean" | "string";

/* jscpd:ignore-start -- Core 镜像公共 SDK 能力形状；可赋值性检查防止漂移。 */
// 视频生成模式能力
export type VideoGenerationModeCapabilities = {
  maxVideos?: number;                                      // 最大视频数量
  maxInputImages?: number;                                // 最大输入图像数量
  maxInputImagesByModel?: Readonly<Record<string, number>>; // 按模型的输入图像限制
  maxInputVideos?: number;                                // 最大输入视频数量
  maxInputVideosByModel?: Readonly<Record<string, number>>; // 按模型的输入视频限制
  /** 提供商接受的最大参考音频资产数量（如背景音乐、语音参考） */
  maxInputAudios?: number;
  maxInputAudiosByModel?: Readonly<Record<string, number>>; // 按模型的输入音频限制
  maxDurationSeconds?: number;                            // 每视频最大时长
  supportedDurationSeconds?: readonly number[];            // 支持的时长列表
  supportedDurationSecondsByModel?: Readonly<Record<string, readonly number[]>>; // 按模型支持的时长
  sizes?: readonly string[];                              // 支持的尺寸列表
  aspectRatios?: readonly string[];                        // 支持的宽高比列表
  resolutions?: readonly VideoGenerationResolution[];      // 支持的分辨率列表
  supportsSize?: boolean;                                   // 是否支持尺寸
  supportsAspectRatio?: boolean;                            // 是否支持宽高比
  supportsResolution?: boolean;                             // 是否支持分辨率
  /** 提供商可以在输出视频中生成音频 */
  supportsAudio?: boolean;
  supportsWatermark?: boolean;                            // 是否支持水印
  /**
   * 声明的 typed schema，用于 opaque `VideoGenerationRequest.providerOptions` 包
   * 这里列出的键被接受；代理传递的任何其他键在运行时回退边界被拒绝，
   * 以便类型错误或提供商特定的选项永远不会静默到达错误的提供商
   * 当前不接受 providerOptions 的插件应将此设为 undefined 或 `{}`
   */
  providerOptions?: Readonly<Record<string, VideoGenerationProviderOptionType>>;
};
/* jscpd:ignore-end */

// 视频生成变换能力
export type VideoGenerationTransformCapabilities = VideoGenerationModeCapabilities & {
  enabled: boolean; // 是否启用
};

// 视频生成提供商能力
export type VideoGenerationProviderCapabilities = VideoGenerationModeCapabilities & {
  generate?: VideoGenerationModeCapabilities;         // 生成模式能力
  imageToVideo?: VideoGenerationTransformCapabilities; // 图生视频能力
  videoToVideo?: VideoGenerationTransformCapabilities; // 视频生视频能力
};

// 视频生成规范化结果
export type VideoGenerationNormalization = {
  size?: MediaNormalizationEntry<string>;                                    // 尺寸规范化
  aspectRatio?: MediaNormalizationEntry<string>;                           // 宽高比规范化
  resolution?: MediaNormalizationEntry<VideoGenerationResolution>;         // 分辨率规范化
  durationSeconds?: MediaNormalizationEntry<number>;                       // 时长规范化
};

// 视频生成提供商接口
export type VideoGenerationProvider = {
  id: string;                                         // 提供商唯一标识符
  aliases?: string[];                                // 别名列表
  label?: string;                                      // 显示标签
  defaultModel?: string;                             // 默认模型
  models?: string[];                                  // 支持的模型列表
  capabilities: VideoGenerationProviderCapabilities; // 提供商能力
  // 检查提供商是否已配置
  isConfigured?: (ctx: VideoGenerationProviderConfiguredContext) => boolean;
  // 生成视频的核心方法
  generateVideo: (req: VideoGenerationRequest) => Promise<VideoGenerationResult>;
};
