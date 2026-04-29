import type { OpenClawConfig } from "../config/types.openclaw.js";
import type {
  ResolvedTtsPersona,
  TtsAutoMode,
  TtsConfig,
  TtsMode,
  TtsProvider,
} from "../config/types.tts.js";
import type { SpeechModelOverridePolicy, SpeechProviderConfig } from "./provider-types.js";

/**
 * 已解析的TTS模型覆盖策略
 */
export type ResolvedTtsModelOverrides = SpeechModelOverridePolicy;

/**
 * 已解析的TTS完整配置
 * auto: 自动模式设置
 * mode: TTS模式
 * provider: TTS提供商
 * providerSource: 提供商来源标识
 * persona: 语音角色
 * personas: 可用语音角色映射
 * summaryModel: 摘要模型
 * modelOverrides: 模型覆盖策略
 * providerConfigs: 提供商配置映射
 * prefsPath: 偏好设置路径
 * maxTextLength: 最大文本长度
 * timeoutMs: 超时毫秒数
 * rawConfig: 原始配置
 * sourceConfig: 来源配置
 */
export type ResolvedTtsConfig = {
  auto: TtsAutoMode;
  mode: TtsMode;
  provider: TtsProvider;
  providerSource: "config" | "default";
  persona?: string;
  personas: Record<string, ResolvedTtsPersona>;
  summaryModel?: string;
  modelOverrides: ResolvedTtsModelOverrides;
  providerConfigs: Record<string, SpeechProviderConfig>;
  prefsPath?: string;
  maxTextLength: number;
  timeoutMs: number;
  rawConfig?: TtsConfig;
  sourceConfig?: OpenClawConfig;
};
