// 引入 Node.js 文件系统和路径模块
import fs from "node:fs/promises";
import path from "node:path";
// 引入提供商 ID 规范化
import { normalizeMediaProviderId } from "./provider-registry.js";
import { findDecisionReason, normalizeDecisionReason } from "./runner.entries.js";
import {
  buildProviderRegistry,
  createMediaAttachmentCache,
  normalizeMediaAttachments,
  runCapability,
} from "./runner.js";
import type {
  DescribeImageFileParams,
  DescribeImageFileWithModelParams,
  DescribeVideoFileParams,
  RunMediaUnderstandingFileParams,
  RunMediaUnderstandingFileResult,
  TranscribeAudioFileParams,
} from "./runtime-types.js";
// 导出运行时类型
export type {
  DescribeImageFileParams,
  DescribeImageFileWithModelParams,
  DescribeVideoFileParams,
  RunMediaUnderstandingFileParams,
  RunMediaUnderstandingFileResult,
  TranscribeAudioFileParams,
} from "./runtime-types.js";

// 媒体理解能力类型
type MediaUnderstandingCapability = "image" | "audio" | "video";
// 媒体理解输出类型
type MediaUnderstandingOutput = Awaited<ReturnType<typeof runCapability>>["outputs"][number];

// 能力到输出类型的映射
const KIND_BY_CAPABILITY: Record<MediaUnderstandingCapability, MediaUnderstandingOutput["kind"]> = {
  audio: "audio.transcription",       // 音频转录
  image: "image.description",         // 图像描述
  video: "video.description",         // 视频描述
};

/**
 * 解析决策失败原因
 * @param decision - 运行能力返回的决策
 * @returns 失败原因字符串或 undefined
 */
function resolveDecisionFailureReason(
  decision: Awaited<ReturnType<typeof runCapability>>["decision"],
): string | undefined {
  return normalizeDecisionReason(findDecisionReason(decision, "failed"));
}

/**
 * 构建文件上下文
 * @param params - 包含文件路径和 MIME 类型的参数
 * @returns 文件上下文对象
 */
function buildFileContext(params: { filePath: string; mime?: string }) {
  return {
    MediaPath: params.filePath,   // 媒体路径
    MediaType: params.mime,      // 媒体类型
  };
}

/**
 * 运行媒体理解文件处理
 * @param params - 运行参数，包含配置、能力、文件路径等
 * @returns 处理结果，包含文本、提供商、模型和输出
 */
export async function runMediaUnderstandingFile(
  params: RunMediaUnderstandingFileParams,
): Promise<RunMediaUnderstandingFileResult> {
  // 提取并规范化请求提示词
  const requestPrompt = params.prompt?.trim();
  // 转换超时时间（毫秒转秒）
  const requestTimeoutSeconds =
    typeof params.timeoutMs === "number" &&
    Number.isFinite(params.timeoutMs) &&
    params.timeoutMs > 0
      ? Math.ceil(params.timeoutMs / 1000)
      : undefined;

  // 构建配置，如有请求提示词或超时则合并到配置中
  const cfg =
    requestPrompt || requestTimeoutSeconds !== undefined
      ? {
          ...params.cfg,
          tools: {
            ...params.cfg.tools,
            media: {
              ...params.cfg.tools?.media,
              [params.capability]: {
                ...params.cfg.tools?.media?.[params.capability],
                // 添加请求提示词覆盖
                ...(requestPrompt
                  ? {
                      prompt: requestPrompt,
                      _requestPromptOverride: requestPrompt,
                    }
                  : {}),
                // 添加超时覆盖
                ...(requestTimeoutSeconds !== undefined
                  ? { timeoutSeconds: requestTimeoutSeconds }
                  : {}),
              },
            },
          },
        }
      : params.cfg;

  // 构建文件上下文
  const ctx = buildFileContext(params);
  // 规范化媒体附件
  const attachments = normalizeMediaAttachments(ctx);
  // 无附件时返回 undefined
  if (attachments.length === 0) {
    return { text: undefined };
  }

  // 获取该能力的配置
  const config = cfg.tools?.media?.[params.capability];
  // 能力被禁用时返回空
  if (config?.enabled === false) {
    return {
      text: undefined,
      provider: undefined,
      model: undefined,
      output: undefined,
    };
  }

  // 构建提供商注册表
  const providerRegistry = buildProviderRegistry(undefined, cfg);
  // 创建媒体附件缓存
  const cache = createMediaAttachmentCache(attachments, {
    localPathRoots: [path.dirname(params.filePath)],  // 本地路径根
    ssrfPolicy: cfg.tools?.web?.fetch?.ssrfPolicy,   // SSRF 防护策略
  });

  try {
    // 运行能力
    const result = await runCapability({
      capability: params.capability,
      cfg,
      ctx,
      attachments: cache,
      media: attachments,
      agentDir: params.agentDir,
      providerRegistry,
      config,
      activeModel: params.activeModel,
    });

    // 无输出且决策失败时抛出错误
    if (result.outputs.length === 0 && result.decision.outcome === "failed") {
      throw new Error(
        resolveDecisionFailureReason(result.decision) ??
          `${params.capability} understanding failed`,
      );
    }

    // 查找匹配的输出
    const output = result.outputs.find(
      (entry) => entry.kind === KIND_BY_CAPABILITY[params.capability],
    );
    // 提取并清理文本
    const text = output?.text?.trim();
    return {
      text: text || undefined,
      provider: output?.provider,
      model: output?.model,
      output,
    };
  } finally {
    // 清理缓存
    await cache.cleanup();
  }
}

/**
 * 描述图像文件
 * @param params - 图像文件参数
 * @returns 图像描述结果
 */
export async function describeImageFile(
  params: DescribeImageFileParams,
): Promise<RunMediaUnderstandingFileResult> {
  return await runMediaUnderstandingFile({ ...params, capability: "image" });
}

/**
 * 使用指定模型描述图像文件
 * @param params - 包含提供商和模型的参数
 * @returns 图像描述结果
 */
export async function describeImageFileWithModel(params: DescribeImageFileWithModelParams) {
  // 设置默认超时 30 秒
  const timeoutMs = params.timeoutMs ?? 30_000;
  // 构建提供商注册表
  const providerRegistry = buildProviderRegistry(undefined, params.cfg);
  // 获取指定提供商
  const provider = providerRegistry.get(normalizeMediaProviderId(params.provider));
  // 检查提供商是否支持图像分析
  if (!provider?.describeImage) {
    throw new Error(`Provider does not support image analysis: ${params.provider}`);
  }
  // 读取文件内容
  const buffer = await fs.readFile(params.filePath);
  // 调用提供商的图像描述方法
  return await provider.describeImage({
    buffer,
    fileName: path.basename(params.filePath),
    mime: params.mime,
    provider: params.provider,
    model: params.model,
    prompt: params.prompt,
    maxTokens: params.maxTokens,
    timeoutMs,
    cfg: params.cfg,
    agentDir: params.agentDir ?? "",
  });
}

/**
 * 描述视频文件
 * @param params - 视频文件参数
 * @returns 视频描述结果
 */
export async function describeVideoFile(
  params: DescribeVideoFileParams,
): Promise<RunMediaUnderstandingFileResult> {
  return await runMediaUnderstandingFile({ ...params, capability: "video" });
}

/**
 * 转录音频文件
 * @param params - 音频文件参数
 * @returns 转录文本结果
 */
export async function transcribeAudioFile(
  params: TranscribeAudioFileParams,
): Promise<{ text: string | undefined }> {
  // 构建配置，添加语言和提示词覆盖
  const cfg =
    params.language || params.prompt
      ? {
          ...params.cfg,
          tools: {
            ...params.cfg.tools,
            media: {
              ...params.cfg.tools?.media,
              audio: {
                ...params.cfg.tools?.media?.audio,
                // 添加语言覆盖
                ...(params.language ? { _requestLanguageOverride: params.language } : {}),
                // 添加提示词覆盖
                ...(params.prompt ? { _requestPromptOverride: params.prompt } : {}),
                // 添加语言设置
                ...(params.language ? { language: params.language } : {}),
                // 添加提示词
                ...(params.prompt ? { prompt: params.prompt } : {}),
              },
            },
          },
        }
      : params.cfg;
  // 运行媒体理解
  const result = await runMediaUnderstandingFile({ ...params, cfg, capability: "audio" });
  return { text: result.text };
}
