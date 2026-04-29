// 引入故障转移错误处理和类型
import { describeFailoverError, isFailoverError } from "../agents/failover-error.js";
import type { FallbackAttempt } from "../agents/model-fallback.types.js";
// 引入模型超时解析和配置类型
import { resolveAgentModelTimeoutMsValue } from "../config/model-input.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
// 引入日志子系统
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  buildMediaGenerationNormalizationMetadata,
  buildNoCapabilityModelConfiguredMessage,
  resolveCapabilityModelCandidates,
  throwCapabilityGenerationFailure,
} from "../media-generation/runtime-shared.js";
// 引入提供商环境变量工具
import { getProviderEnvVars } from "../secrets/provider-env-vars.js";
// 引入图像生成模型引用解析和规范化
import { parseImageGenerationModelRef } from "./model-ref.js";
import { resolveImageGenerationOverrides } from "./normalization.js";
// 引入图像生成提供商注册表
import { getImageGenerationProvider, listImageGenerationProviders } from "./provider-registry.js";
import type { GenerateImageParams, GenerateImageRuntimeResult } from "./runtime-types.js";
import type { ImageGenerationResult } from "./types.js";

// 创建图像生成子系统日志记录器
const log = createSubsystemLogger("image-generation");

// 图像生成运行时依赖项类型
export type ImageGenerationRuntimeDeps = {
  getProvider?: typeof getImageGenerationProvider;            // 获取提供商函数
  listProviders?: typeof listImageGenerationProviders;       // 列出提供商函数
  getProviderEnvVars?: typeof getProviderEnvVars;            // 获取环境变量函数
  log?: Pick<typeof log, "warn">;                           // 日志记录器
};

// 导出运行时类型别名
export type { GenerateImageParams, GenerateImageRuntimeResult } from "./runtime-types.js";

/**
 * 构建未配置图像生成模型时的错误消息
 * @param cfg - OpenClaw 配置
 * @param deps - 运行时依赖
 * @returns 格式化的错误消息
 */
function buildNoImageGenerationModelConfiguredMessage(
  cfg: OpenClawConfig,
  deps: ImageGenerationRuntimeDeps,
): string {
  const listProviders = deps.listProviders ?? listImageGenerationProviders;
  return buildNoCapabilityModelConfiguredMessage({
    capabilityLabel: "image-generation",         // 功能标签
    modelConfigKey: "imageGenerationModel",     // 模型配置键
    providers: listProviders(cfg),             // 可用提供商列表
    getProviderEnvVars: deps.getProviderEnvVars,
  });
}

/**
 * 列出运行时可用的图像生成提供商
 * @param params - 可选配置参数
 * @param deps - 运行时依赖
 * @returns 提供商列表
 */
export function listRuntimeImageGenerationProviders(
  params?: { config?: OpenClawConfig },
  deps: ImageGenerationRuntimeDeps = {},
) {
  return (deps.listProviders ?? listImageGenerationProviders)(params?.config);
}

/**
 * 生成图像
 * @param params - 生成参数
 * @param deps - 运行时依赖
 * @returns 生成结果，包含图像数据、提供商、模型等信息
 */
export async function generateImage(
  params: GenerateImageParams,
  deps: ImageGenerationRuntimeDeps = {},
): Promise<GenerateImageRuntimeResult> {
  // 获取提供商函数（支持依赖注入）
  const getProvider = deps.getProvider ?? getImageGenerationProvider;
  const listProviders = deps.listProviders ?? listImageGenerationProviders;
  const logger = deps.log ?? log;
  // 解析超时时间
  const timeoutMs =
    params.timeoutMs ??
    resolveAgentModelTimeoutMsValue(params.cfg.agents?.defaults?.imageGenerationModel);

  // 解析候选模型列表
  const candidates = resolveCapabilityModelCandidates({
    cfg: params.cfg,
    modelConfig: params.cfg.agents?.defaults?.imageGenerationModel,
    modelOverride: params.modelOverride,
    parseModelRef: parseImageGenerationModelRef,
    agentDir: params.agentDir,
    listProviders,
  });

  // 没有可用候选模型时抛出错误
  if (candidates.length === 0) {
    throw new Error(buildNoImageGenerationModelConfiguredMessage(params.cfg, deps));
  }

  const attempts: FallbackAttempt[] = []; // 记录每次尝试
  let lastError: unknown;                  // 最后一个错误

  // 遍历候选模型进行重试
  for (const candidate of candidates) {
    const provider = getProvider(candidate.provider, params.cfg);
    if (!provider) {
      // 提供商不存在
      const error = `No image-generation provider registered for ${candidate.provider}`;
      attempts.push({
        provider: candidate.provider,
        model: candidate.model,
        error,
      });
      lastError = new Error(error);
      logger.warn(
        `image-generation candidate failed: ${candidate.provider}/${candidate.model}: ${error}`,
      );
      continue;
    }

    try {
      // 规范化参数（处理提供商不支持的选项）
      const sanitized = resolveImageGenerationOverrides({
        provider,
        size: params.size,
        aspectRatio: params.aspectRatio,
        resolution: params.resolution,
        quality: params.quality,
        outputFormat: params.outputFormat,
        background: params.background,
        inputImages: params.inputImages,
      });

      // 调用提供商生成图像
      const result: ImageGenerationResult = await provider.generateImage({
        provider: candidate.provider,
        model: candidate.model,
        prompt: params.prompt,
        cfg: params.cfg,
        agentDir: params.agentDir,
        authStore: params.authStore,
        count: params.count,
        size: sanitized.size,
        aspectRatio: sanitized.aspectRatio,
        resolution: sanitized.resolution,
        quality: sanitized.quality,
        outputFormat: sanitized.outputFormat,
        background: sanitized.background,
        inputImages: params.inputImages,
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        providerOptions: params.providerOptions,
      });

      // 验证返回结果
      if (!Array.isArray(result.images) || result.images.length === 0) {
        throw new Error("Image generation provider returned no images.");
      }

      // 返回成功结果
      return {
        images: result.images,
        provider: candidate.provider,
        model: result.model ?? candidate.model,
        attempts,
        normalization: sanitized.normalization,
        metadata: {
          ...result.metadata,
          ...buildMediaGenerationNormalizationMetadata({
            normalization: sanitized.normalization,
            requestedSizeForDerivedAspectRatio: params.size,
          }),
        },
        ignoredOverrides: sanitized.ignoredOverrides,
      };
    } catch (err) {
      // 记录失败尝试
      lastError = err;
      const described = isFailoverError(err) ? describeFailoverError(err) : undefined;
      attempts.push({
        provider: candidate.provider,
        model: candidate.model,
        error: described?.message ?? formatErrorMessage(err),
        reason: described?.reason,
        status: described?.status,
        code: described?.code,
      });
      logger.warn(
        `image-generation candidate failed: ${candidate.provider}/${candidate.model}: ${
          described?.message ?? formatErrorMessage(err)
        }`,
      );
    }
  }

  // 所有候选都失败，抛出最终错误
  return throwCapabilityGenerationFailure({
    capabilityLabel: "image generation",
    attempts,
    lastError,
  });
}
