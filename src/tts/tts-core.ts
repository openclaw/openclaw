import { completeSimple, type TextContent } from "@mariozechner/pi-ai";
import { getApiKeyForModel, requireApiKey } from "../agents/model-auth.js";
import {
  buildModelAliasIndex,
  resolveDefaultModelForAgent,
  resolveModelRefFromString,
  type ModelRef,
} from "../agents/model-selection.js";
import { resolveModelAsync } from "../agents/pi-embedded-runner/model.js";
import { prepareModelForSimpleCompletion } from "../agents/simple-completion-transport.js";
import type { OpenClawConfig } from "../config/types.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import type { ResolvedTtsConfig } from "./tts-types.js";
export {
  normalizeApplyTextNormalization,
  normalizeLanguageCode,
  normalizeSeed,
  requireInRange,
  scheduleCleanup,
} from "./tts-provider-helpers.js";

/**
 * 文本摘要依赖类型
 */
type SummarizeTextDeps = {
  completeSimple: typeof completeSimple;
  getApiKeyForModel: typeof getApiKeyForModel;
  prepareModelForSimpleCompletion: typeof prepareModelForSimpleCompletion;
  requireApiKey: typeof requireApiKey;
  resolveModelAsync: typeof resolveModelAsync;
};

/**
 * 获取默认的摘要文本依赖
 * @returns 依赖对象
 */
function resolveDefaultSummarizeTextDeps(): SummarizeTextDeps {
  return {
    completeSimple,
    getApiKeyForModel,
    prepareModelForSimpleCompletion,
    requireApiKey,
    resolveModelAsync,
  };
}

/**
 * 摘要结果类型
 */
type SummarizeResult = {
  summary: string;
  latencyMs: number;
  inputLength: number;
  outputLength: number;
};

/**
 * 摘要模型选择类型
 */
type SummaryModelSelection = {
  ref: ModelRef;
  source: "summaryModel" | "default";
};

/**
 * 解析摘要模型引用
 * @param cfg - OpenClaw配置
 * @param config - TTS配置
 * @returns 模型选择结果
 */
function resolveSummaryModelRef(
  cfg: OpenClawConfig,
  config: ResolvedTtsConfig,
): SummaryModelSelection {
  const defaultRef = resolveDefaultModelForAgent({ cfg });
  const override = normalizeOptionalString(config.summaryModel);
  if (!override) {
    return { ref: defaultRef, source: "default" };
  }

  const aliasIndex = buildModelAliasIndex({ cfg, defaultProvider: defaultRef.provider });
  const resolved = resolveModelRefFromString({
    raw: override,
    defaultProvider: defaultRef.provider,
    aliasIndex,
  });
  if (!resolved) {
    return { ref: defaultRef, source: "default" };
  }
  return { ref: resolved.ref, source: "summaryModel" };
}

/**
 * 检查块是否为文本内容块
 * @param block - 内容块
 * @returns 是否为文本块
 */
function isTextContentBlock(block: { type: string }): block is TextContent {
  return block.type === "text";
}

/**
 * 摘要文本
 * 使用AI模型将文本摘要到目标长度
 * @param params - 包含文本、目标长度、配置和超时的参数
 * @param deps - 可选的依赖注入
 * @returns 摘要结果
 */
export async function summarizeText(
  params: {
    text: string;
    targetLength: number;
    cfg: OpenClawConfig;
    config: ResolvedTtsConfig;
    timeoutMs: number;
  },
  deps: SummarizeTextDeps = resolveDefaultSummarizeTextDeps(),
): Promise<SummarizeResult> {
  const { text, targetLength, cfg, config, timeoutMs } = params;
  if (targetLength < 100 || targetLength > 10_000) {
    throw new Error(`Invalid targetLength: ${targetLength}`);
  }

  const startTime = Date.now();
  const { ref } = resolveSummaryModelRef(cfg, config);
  const resolved = await deps.resolveModelAsync(ref.provider, ref.model, undefined, cfg);
  if (!resolved.model) {
    throw new Error(resolved.error ?? `Unknown summary model: ${ref.provider}/${ref.model}`);
  }
  const completionModel = deps.prepareModelForSimpleCompletion({ model: resolved.model, cfg });
  const apiKey = deps.requireApiKey(
    await deps.getApiKeyForModel({ model: completionModel, cfg }),
    ref.provider,
  );

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await deps.completeSimple(
        completionModel,
        {
          messages: [
            {
              role: "user",
              content:
                `You are an assistant that summarizes texts concisely while keeping the most important information. ` +
                `Summarize the text to approximately ${targetLength} characters. Maintain the original tone and style. ` +
                `Reply only with the summary, without additional explanations.\n\n` +
                `<text_to_summarize>\n${text}\n</text_to_summarize>`,
              timestamp: Date.now(),
            },
          ],
        },
        {
          apiKey,
          maxTokens: Math.ceil(targetLength / 2),
          temperature: 0.3,
          signal: controller.signal,
        },
      );
      const summary = res.content
        .filter(isTextContentBlock)
        .map((block) => block.text.trim())
        .filter(Boolean)
        .join(" ")
        .trim();

      if (!summary) {
        throw new Error("No summary returned");
      }

      return {
        summary,
        latencyMs: Date.now() - startTime,
        inputLength: text.length,
        outputLength: summary.length,
      };
    } finally {
      clearTimeout(timeout);
    }
  } catch (err) {
    const error = err as Error;
    if (error.name === "AbortError") {
      throw new Error("Summarization timed out", { cause: err });
    }
    throw err;
  }
}
