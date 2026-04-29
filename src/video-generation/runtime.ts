// 引入故障转移尝试类型
import type { FallbackAttempt } from "../agents/model-fallback.types.js";
// 引入 OpenClaw 配置类型
import type { OpenClawConfig } from "../config/types.openclaw.js";
// 引入日志子系统
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  buildMediaGenerationNormalizationMetadata,
  buildNoCapabilityModelConfiguredMessage,
  recordCapabilityCandidateFailure,
  resolveCapabilityModelCandidates,
  throwCapabilityGenerationFailure,
} from "../media-generation/runtime-shared.js";
// 引入提供商环境变量工具
import { getProviderEnvVars } from "../secrets/provider-env-vars.js";
// 引入视频生成能力解析和时长支持
import { resolveVideoGenerationModeCapabilities } from "./capabilities.js";
import { resolveVideoGenerationSupportedDurations } from "./duration-support.js";
// 引入视频生成模型引用解析和规范化
import { parseVideoGenerationModelRef } from "./model-ref.js";
import { resolveVideoGenerationOverrides } from "./normalization.js";
// 引入视频生成提供商注册表
import { getVideoGenerationProvider, listVideoGenerationProviders } from "./provider-registry.js";
import type { GenerateVideoParams, GenerateVideoRuntimeResult } from "./runtime-types.js";
import type { VideoGenerationProviderOptionType, VideoGenerationResult } from "./types.js";

// 创建视频生成子系统日志记录器
const log = createSubsystemLogger("video-generation");

// 视频生成运行时依赖项类型
export type VideoGenerationRuntimeDeps = {
  getProvider?: typeof getVideoGenerationProvider;            // 获取提供商函数
  listProviders?: typeof listVideoGenerationProviders;       // 列出提供商函数
  getProviderEnvVars?: typeof getProviderEnvVars;            // 获取环境变量函数
  log?: Pick<typeof log, "debug" | "warn">;                 // 日志记录器
};

// 导出运行时类型别名
export type { GenerateVideoParams, GenerateVideoRuntimeResult } from "./runtime-types.js";

/**
 * 验证代理提供的 providerOptions 是否与候选声明的 schema 匹配
 * 当候选不能接受提供的选项时返回人类可读的跳过原因，
 * 当一切检查通过时返回 undefined
 *
 * 向后兼容行为：
 * - 提供商未声明 schema（undefined）：按原样传递选项，提供商可能静默忽略未知键
 * - 提供商显式声明空 schema（{}）：拒绝任何选项，这是已审核且真正不支持选项的 opt-in 信号
 * - 提供商声明类型 schema：验证每个键名和值类型，任何不匹配时跳过候选
 *
 * @param params - 验证参数
 * @returns 跳过原因或 undefined（验证通过）
 */
function validateProviderOptionsAgainstDeclaration(params: {
  providerId: string;                                     // 提供商 ID
  model: string;                                           // 模型名称
  providerOptions: Record<string, unknown>;               // 提供的选项
  declaration: Readonly<Record<string, VideoGenerationProviderOptionType>> | undefined; // 声明的 schema
}): string | undefined {
  const { providerId, model, providerOptions, declaration } = params;
  const keys = Object.keys(providerOptions);
  if (keys.length === 0) {
    return undefined; // 无选项，无需验证
  }
  if (declaration === undefined) {
    return undefined; // 未声明 schema，按原样传递
  }
  if (Object.keys(declaration).length === 0) {
    // 显式声明空 schema，拒绝所有选项
    return `${providerId}/${model} does not accept providerOptions (caller supplied: ${keys.join(", ")}); skipping`;
  }
  // 检查未知键
  const unknown = keys.filter((key) => !Object.hasOwn(declaration, key));
  if (unknown.length > 0) {
    const accepted = Object.keys(declaration).join(", ");
    return `${providerId}/${model} does not accept providerOptions keys: ${unknown.join(", ")} (accepted: ${accepted}); skipping`;
  }
  // 验证每个键的值类型
  for (const key of keys) {
    const expected = declaration[key];
    const value = providerOptions[key];
    const actual = typeof value;
    // 数值类型检查
    if (expected === "number" && (actual !== "number" || !Number.isFinite(value as number))) {
      return `${providerId}/${model} expects providerOptions.${key} to be a finite number, got ${actual}; skipping`;
    }
    // 布尔类型检查
    if (expected === "boolean" && actual !== "boolean") {
      return `${providerId}/${model} expects providerOptions.${key} to be a boolean, got ${actual}; skipping`;
    }
    // 字符串类型检查
    if (expected === "string" && actual !== "string") {
      return `${providerId}/${model} expects providerOptions.${key} to be a string, got ${actual}; skipping`;
    }
  }
  return undefined;
}

/**
 * 构建未配置视频生成模型时的错误消息
 * @param cfg - OpenClaw 配置
 * @param deps - 运行时依赖
 * @returns 格式化的错误消息
 */
function buildNoVideoGenerationModelConfiguredMessage(
  cfg: OpenClawConfig,
  deps: VideoGenerationRuntimeDeps,
): string {
  const listProviders = deps.listProviders ?? listVideoGenerationProviders;
  return buildNoCapabilityModelConfiguredMessage({
    capabilityLabel: "video-generation",      // 功能标签
    modelConfigKey: "videoGenerationModel",   // 模型配置键
    providers: listProviders(cfg),           // 可用提供商列表
    getProviderEnvVars: deps.getProviderEnvVars,
  });
}

/**
 * 列出运行时可用的视频生成提供商
 * @param params - 可选配置参数
 * @param deps - 运行时依赖
 * @returns 提供商列表
 */
export function listRuntimeVideoGenerationProviders(
  params?: { config?: OpenClawConfig },
  deps: VideoGenerationRuntimeDeps = {},
) {
  return (deps.listProviders ?? listVideoGenerationProviders)(params?.config);
}

/**
 * 生成视频
 * @param params - 生成参数
 * @param deps - 运行时依赖
 * @returns 生成结果，包含视频数据、提供商、模型等信息
 */
export async function generateVideo(
  params: GenerateVideoParams,
  deps: VideoGenerationRuntimeDeps = {},
): Promise<GenerateVideoRuntimeResult> {
  // 获取提供商函数（支持依赖注入）
  const getProvider = deps.getProvider ?? getVideoGenerationProvider;
  const listProviders = deps.listProviders ?? listVideoGenerationProviders;
  const logger = deps.log ?? log;

  // 解析候选模型列表
  const candidates = resolveCapabilityModelCandidates({
    cfg: params.cfg,
    modelConfig: params.cfg.agents?.defaults?.videoGenerationModel,
    modelOverride: params.modelOverride,
    parseModelRef: parseVideoGenerationModelRef,
    agentDir: params.agentDir,
    listProviders,
  });

  // 没有可用候选模型时抛出错误
  if (candidates.length === 0) {
    throw new Error(buildNoVideoGenerationModelConfiguredMessage(params.cfg, deps));
  }

  const attempts: FallbackAttempt[] = []; // 记录每次尝试
  let lastError: unknown;                  // 最后一个错误
  let skipWarnEmitted = false;             // 跳过警告是否已发出
  // 首次跳过时记录 warn 级别，之后只记录 debug
  const warnOnFirstSkip = (reason: string) => {
    if (!skipWarnEmitted) {
      skipWarnEmitted = true;
      logger.warn(`video-generation candidate skipped: ${reason}`);
    }
  };

  // 遍历候选模型进行重试
  for (const candidate of candidates) {
    const provider = getProvider(candidate.provider, params.cfg);
    if (!provider) {
      const error = `No video-generation provider registered for ${candidate.provider}`;
      attempts.push({
        provider: candidate.provider,
        model: candidate.model,
        error,
      });
      lastError = new Error(error);
      continue;
    }

    // 防护：检查候选是否满足参考输入数量的要求
    // 避免静默丢弃音频/图像/视频引用
    const inputImageCount = params.inputImages?.length ?? 0;
    const inputVideoCount = params.inputVideos?.length ?? 0;
    const inputAudioCount = params.inputAudios?.length ?? 0;
    if (inputAudioCount > 0) {
      const { capabilities: candCaps } = resolveVideoGenerationModeCapabilities({
        provider,
        model: candidate.model,
        inputImageCount,
        inputVideoCount,
      });
      // 回退到 flat provider.capabilities.maxInputAudios（某些提供商直接设置）
      const maxAudio = candCaps?.maxInputAudios ?? provider.capabilities.maxInputAudios ?? 0;
      if (inputAudioCount > maxAudio) {
        const error =
          maxAudio === 0
            ? `${candidate.provider}/${candidate.model} does not support reference audio inputs; skipping to avoid silent audio drop`
            : `${candidate.provider}/${candidate.model} supports at most ${maxAudio} reference audio(s), ${inputAudioCount} requested; skipping`;
        attempts.push({ provider: candidate.provider, model: candidate.model, error });
        lastError = new Error(error);
        warnOnFirstSkip(error);
        logger.debug(
          `video-generation candidate skipped (audio capability): ${candidate.provider}/${candidate.model}`,
        );
        continue;
      }
    }

    // 防护：检查候选是否接受请求的 providerOptions
    if (
      params.providerOptions &&
      typeof params.providerOptions === "object" &&
      Object.keys(params.providerOptions).length > 0
    ) {
      const { capabilities: optCaps } = resolveVideoGenerationModeCapabilities({
        provider,
        model: candidate.model,
        inputImageCount,
        inputVideoCount,
      });
      const declaredOptions =
        optCaps?.providerOptions ?? provider.capabilities.providerOptions ?? undefined;
      const mismatch = validateProviderOptionsAgainstDeclaration({
        providerId: candidate.provider,
        model: candidate.model,
        providerOptions: params.providerOptions,
        declaration: declaredOptions,
      });
      if (mismatch) {
        attempts.push({ provider: candidate.provider, model: candidate.model, error: mismatch });
        lastError = new Error(mismatch);
        warnOnFirstSkip(mismatch);
        logger.debug(
          `video-generation candidate skipped (providerOptions): ${candidate.provider}/${candidate.model}`,
        );
        continue;
      }
    }

    // 防护：检查 maxDurationSeconds 硬限制是否低于请求的时长
    const requestedDuration = params.durationSeconds;
    if (typeof requestedDuration === "number" && Number.isFinite(requestedDuration)) {
      const { capabilities: durCaps } = resolveVideoGenerationModeCapabilities({
        provider,
        model: candidate.model,
        inputImageCount,
        inputVideoCount,
      });
      const supportedDurations = resolveVideoGenerationSupportedDurations({
        provider,
        model: candidate.model,
        inputImageCount,
        inputVideoCount,
      });
      const maxDuration = durCaps?.maxDurationSeconds ?? provider.capabilities.maxDurationSeconds;
      if (
        !supportedDurations &&
        typeof maxDuration === "number" &&
        // 使用规范化（四舍五入）的时长进行比较
        Math.round(requestedDuration) > maxDuration
      ) {
        const error = `${candidate.provider}/${candidate.model} supports at most ${maxDuration}s per video, ${requestedDuration}s requested; skipping`;
        attempts.push({ provider: candidate.provider, model: candidate.model, error });
        lastError = new Error(error);
        warnOnFirstSkip(error);
        logger.debug(
          `video-generation candidate skipped (duration capability): ${candidate.provider}/${candidate.model}`,
        );
        continue;
      }
    }

    try {
      // 规范化参数（处理提供商不支持的选项）
      const sanitized = resolveVideoGenerationOverrides({
        provider,
        model: candidate.model,
        size: params.size,
        aspectRatio: params.aspectRatio,
        resolution: params.resolution,
        durationSeconds: params.durationSeconds,
        audio: params.audio,
        watermark: params.watermark,
        inputImageCount,
        inputVideoCount,
      });

      // 调用提供商生成视频
      const result: VideoGenerationResult = await provider.generateVideo({
        provider: candidate.provider,
        model: candidate.model,
        prompt: params.prompt,
        cfg: params.cfg,
        agentDir: params.agentDir,
        authStore: params.authStore,
        size: sanitized.size,
        aspectRatio: sanitized.aspectRatio,
        resolution: sanitized.resolution,
        durationSeconds: sanitized.durationSeconds,
        audio: sanitized.audio,
        watermark: sanitized.watermark,
        inputImages: params.inputImages,
        inputVideos: params.inputVideos,
        inputAudios: params.inputAudios,
        providerOptions: params.providerOptions,
        ...(params.timeoutMs !== undefined ? { timeoutMs: params.timeoutMs } : {}),
      });

      // 验证返回结果
      if (!Array.isArray(result.videos) || result.videos.length === 0) {
        throw new Error("Video generation provider returned no videos.");
      }
      // 验证每个视频都有 buffer 或 url
      for (const [index, video] of result.videos.entries()) {
        if (!video.buffer && !video.url) {
          throw new Error(
            `Video generation provider returned an undeliverable asset at index ${index}: neither buffer nor url is set.`,
          );
        }
      }

      // 返回成功结果
      return {
        videos: result.videos,
        provider: candidate.provider,
        model: result.model ?? candidate.model,
        attempts,
        normalization: sanitized.normalization,
        ignoredOverrides: sanitized.ignoredOverrides,
        metadata: {
          ...result.metadata,
          ...buildMediaGenerationNormalizationMetadata({
            normalization: sanitized.normalization,
            requestedSizeForDerivedAspectRatio: params.size,
            includeSupportedDurationSeconds: true,
          }),
        },
      };
    } catch (err) {
      // 记录失败尝试
      lastError = err;
      recordCapabilityCandidateFailure({
        attempts,
        provider: candidate.provider,
        model: candidate.model,
        error: err,
      });
      logger.debug(`video-generation candidate failed: ${candidate.provider}/${candidate.model}`);
    }
  }

  // 所有候选都失败，抛出最终错误
  return throwCapabilityGenerationFailure({
    capabilityLabel: "video generation",
    attempts,
    lastError,
  });
}
