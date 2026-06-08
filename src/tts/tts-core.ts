// TTS core coordinates text preparation, provider selection, and speech output.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { requireApiKey } from "../agents/model-auth.js";
import {
  buildModelAliasIndex,
  resolveDefaultModelForAgent,
  resolveModelRefFromString,
  type ModelRef,
} from "../agents/model-selection.js";
import { prepareSimpleCompletionModel } from "../agents/simple-completion-runtime.js";
import type { OpenClawConfig } from "../config/types.js";
import { completeSimple } from "../llm/stream.js";
import type { TextContent } from "../llm/types.js";
import { resolveTimerTimeoutMs } from "../shared/number-coercion.js";
import { sanitizeAssistantVisibleText } from "../shared/text/assistant-visible-text.js";
import type { ResolvedTtsConfig } from "./tts-types.js";
export {
  normalizeApplyTextNormalization,
  normalizeLanguageCode,
  normalizeSeed,
  requireInRange,
  scheduleCleanup,
} from "./tts-provider-helpers.js";

type SummarizeTextDeps = {
  completeSimple: typeof completeSimple;
  prepareSimpleCompletionModel: typeof prepareSimpleCompletionModel;
  requireApiKey: typeof requireApiKey;
};

function resolveDefaultSummarizeTextDeps(): SummarizeTextDeps {
  return {
    completeSimple,
    prepareSimpleCompletionModel,
    requireApiKey,
  };
}

type SummarizeResult = {
  summary: string;
  latencyMs: number;
  inputLength: number;
  outputLength: number;
};

type SummaryModelSelection = {
  ref: ModelRef;
  source: "summaryModel" | "default";
};

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

function isTextContentBlock(block: { type: string }): block is TextContent {
  return block.type === "text";
}

const TEXT_TO_SUMMARIZE_PROMPT_BLOCK_RE =
  /(^|\r?\n|[.!?][)"'\]]*)[\t ]*<\s*text_to_summarize\b[^>]*>[\s\S]*?(?:<\s*\/\s*text_to_summarize\s*>|$)/gi;
const SAME_LINE_TEXT_TO_SUMMARIZE_PROMPT_BLOCK_RE =
  /([^\s<])[\t ]+<\s*text_to_summarize\b[^>]*>[\s\S]*?(?:<\s*\/\s*text_to_summarize\s*>|$)/gi;
const TEXT_TO_SUMMARIZE_OPEN_TAG_RE = /^.*?<\s*text_to_summarize\b[^>]*>/is;
const SOURCE_ECHO_PREFIX_LENGTH = 32;
const MIN_SOURCE_ECHO_PREFIX_LENGTH = 12;
const SUMMARY_PROMPT_INSTRUCTIONS_ECHO_RE =
  /^you are an assistant that summarizes texts concisely while keeping the most important information\.\s+summarize the text to approximately \d+ characters\.\s+maintain the original tone and style\.\s+reply only with the summary, without additional explanations\.\s*/i;
const USER_SUMMARY_PROMPT_ECHO = String.raw`the user (?:wants|asks|asked|requested) me to summarize`;
const USER_SUMMARY_TARGET_ECHO = String.raw`(?:(?:the\s+)?(?:provided|following|above|original|given|this)\s+(?:text|content|message|response|passage)|text to summarize)`;
const USER_SUMMARY_METADATA_ECHO = String.raw`${USER_SUMMARY_PROMPT_ECHO}\s+${USER_SUMMARY_TARGET_ECHO}(?:\s+about\b[^.!?\n]*)?\s+to\s+approximately\s+[\d,]+\s+characters\b[^.!?\n]*\.`;
const LEADING_SUMMARY_PROMPT_ECHO_RE = new RegExp(
  String.raw`^(?:(?:${USER_SUMMARY_METADATA_ECHO}|${USER_SUMMARY_PROMPT_ECHO}(?:\s+${USER_SUMMARY_TARGET_ECHO})?(?:\s+for\s+(?:audio|tts))?\.|${USER_SUMMARY_PROMPT_ECHO}\s*(?::|—|–|\s-\s)|i (?:need|should|will|'ll) (?:to )?(?:summarize|include|keep|maintain|craft|write|produce)(?:\s+(?:the\s+)?(?:summary|key points?|important information|original tone|tone and style))?\.|let me (?:craft|write|produce|summarize)(?:\s+(?:a\s+)?summary)?\.)\s*)+`,
  "i",
);

function stripExactTextToSummarizePromptBlock(text: string, sourceText: string): string {
  return text.replace(`<text_to_summarize>\n${sourceText}\n</text_to_summarize>`, "");
}

function stripSameLineTextToSummarizePromptBlocks(text: string, sourceText: string): string {
  const normalizedSourceText = sourceText.replace(/\s+/g, " ").trim();
  if (normalizedSourceText.length < MIN_SOURCE_ECHO_PREFIX_LENGTH) {
    return text;
  }
  const sourcePrefix = normalizedSourceText.slice(
    0,
    Math.min(normalizedSourceText.length, SOURCE_ECHO_PREFIX_LENGTH),
  );
  return text.replace(
    SAME_LINE_TEXT_TO_SUMMARIZE_PROMPT_BLOCK_RE,
    (match: string, prefix: string, offset: number, fullText: string) => {
      const hasInlineContinuation =
        /<\s*\/\s*text_to_summarize\s*>\s*$/i.test(match) &&
        /^[\t ]+\S/.test(fullText.slice(offset + match.length));
      if (hasInlineContinuation) {
        return match;
      }
      const candidateSourceEcho = match
        .replace(TEXT_TO_SUMMARIZE_OPEN_TAG_RE, "")
        .replace(/\s+/g, " ")
        .trimStart();
      return candidateSourceEcho.startsWith(sourcePrefix) ? prefix : match;
    },
  );
}

function sanitizeSummaryForSpeech(summary: string, sourceText: string): string {
  const withoutAssistantScaffolding = sanitizeAssistantVisibleText(summary).trim();
  const withoutPromptInstructions = withoutAssistantScaffolding
    .replace(SUMMARY_PROMPT_INSTRUCTIONS_ECHO_RE, "")
    .trim();
  const withoutExactPromptBlock = stripExactTextToSummarizePromptBlock(
    withoutPromptInstructions,
    sourceText,
  ).trim();
  const withoutPromptBlock = withoutExactPromptBlock
    .replace(TEXT_TO_SUMMARIZE_PROMPT_BLOCK_RE, "$1")
    .trim();
  const withoutSameLinePromptBlock = stripSameLineTextToSummarizePromptBlocks(
    withoutPromptBlock,
    sourceText,
  ).trim();
  const withoutPromptEcho = withoutSameLinePromptBlock
    .replace(LEADING_SUMMARY_PROMPT_ECHO_RE, "")
    .trim();
  return withoutPromptEcho.trim();
}

/** Summarize long text before synthesis using the configured summary model. */
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
  // Dynamic model discovery precedes the request timeout, matching the established
  // summarization contract. The timeout below bounds only the completion request.
  const prepared = await deps.prepareSimpleCompletionModel({
    cfg,
    provider: ref.provider,
    modelId: ref.model,
    useAsyncModelResolution: true,
  });
  if ("error" in prepared) {
    throw new Error(prepared.error);
  }
  const completionModel = prepared.model;
  const apiKey = deps.requireApiKey(prepared.auth, ref.provider);

  try {
    const controller = new AbortController();
    const resolvedTimeoutMs = resolveTimerTimeoutMs(timeoutMs, 1);
    const timeout = setTimeout(() => controller.abort(), resolvedTimeoutMs);

    try {
      // Keep summarization on the simple-completion path so provider auth,
      // aliases, and timeout behavior match other lightweight model calls.
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
        .join("\n")
        .trim();
      const sanitizedSummary = sanitizeSummaryForSpeech(summary, text);

      if (!sanitizedSummary) {
        throw new Error("No summary returned");
      }

      return {
        summary: sanitizedSummary,
        latencyMs: Date.now() - startTime,
        inputLength: text.length,
        outputLength: sanitizedSummary.length,
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
