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
  /<\s*text_to_summarize\b[^>]*>[\s\S]*?<\s*\/\s*text_to_summarize\s*>/gi;
const USER_SUMMARY_PROMPT_ECHO_RE = /^the user (?:wants|asks|asked|requested) me to summarize\b/i;
const SELF_SUMMARY_PROMPT_ECHO_RE =
  /^i (?:need|should|will|'ll) (?:to )?(?:summarize|include|keep|maintain|craft|write|produce)\b/i;
const CRAFT_SUMMARY_PROMPT_ECHO_RE = /^let me (?:craft|write|produce|summarize)\b/i;
const GENERIC_USER_SUMMARY_TARGET_RE =
  /\b(?:(?:provided|following|above|original|given|this)\s+(?:text|content|message|response|passage)|text to summarize|key points?|important information|original tone|tone and style|approximately|characters?|concise|audio|tts)\b/i;
const SUMMARY_PROMPT_META_RE =
  /\b(?:summari[sz]e|summary|key points?|important information|original tone|tone and style|approximately|characters?|concise|audio|text to summarize)\b/i;
const PROMPT_ECHO_SEPARATOR_RE = /\s*(?::|—|–|\s-\s)\s*/;

function findFirstSentenceEnd(text: string): { index: number; found: boolean } {
  const match = /^(.*?(?:[.!?](?=\s|$)|\r?\n+))/s.exec(text);
  return { index: match?.[0].length ?? text.length, found: Boolean(match) };
}

function splitPromptEchoPrefix(text: string): { prefix: string; rest: string } | undefined {
  const match = PROMPT_ECHO_SEPARATOR_RE.exec(text);
  if (!match || match.index === 0) {
    return undefined;
  }
  const restStart = match.index + match[0].length;
  const rest = text.slice(restStart).trimStart();
  if (!rest) {
    return undefined;
  }
  return {
    prefix: text.slice(0, match.index).trim(),
    rest,
  };
}

function isLeadingSummaryPromptEchoSentence(sentence: string): boolean {
  if (USER_SUMMARY_PROMPT_ECHO_RE.test(sentence)) {
    return GENERIC_USER_SUMMARY_TARGET_RE.test(sentence);
  }
  if (SELF_SUMMARY_PROMPT_ECHO_RE.test(sentence) || CRAFT_SUMMARY_PROMPT_ECHO_RE.test(sentence)) {
    return SUMMARY_PROMPT_META_RE.test(sentence);
  }
  return false;
}

function isSeparatedSummaryPromptEchoPrefix(prefix: string): boolean {
  return (
    USER_SUMMARY_PROMPT_ECHO_RE.test(prefix) ||
    (SELF_SUMMARY_PROMPT_ECHO_RE.test(prefix) && SUMMARY_PROMPT_META_RE.test(prefix)) ||
    (CRAFT_SUMMARY_PROMPT_ECHO_RE.test(prefix) && SUMMARY_PROMPT_META_RE.test(prefix))
  );
}

function stripLeadingSummaryPromptEcho(text: string): string {
  let remaining = text.trimStart();
  let stripped = false;
  while (remaining) {
    const separated = splitPromptEchoPrefix(remaining);
    if (separated && isSeparatedSummaryPromptEchoPrefix(separated.prefix)) {
      stripped = true;
      remaining = separated.rest;
      continue;
    }

    const sentenceEnd = findFirstSentenceEnd(remaining);
    const sentence = remaining.slice(0, sentenceEnd.index).trim();
    if (!isLeadingSummaryPromptEchoSentence(sentence)) {
      break;
    }
    if (!sentenceEnd.found) {
      break;
    }
    stripped = true;
    remaining = remaining.slice(sentenceEnd.index).trimStart();
  }
  return stripped ? remaining : text;
}

function truncateSummaryToTargetLength(text: string, targetLength: number): string {
  if (text.length <= targetLength) {
    return text;
  }
  const truncated = text.slice(0, targetLength - 3).trimEnd();
  const wordBoundary = truncated.lastIndexOf(" ");
  const minimumBoundary = Math.floor(targetLength * 0.6);
  const body =
    wordBoundary >= minimumBoundary ? truncated.slice(0, wordBoundary).trimEnd() : truncated;
  return `${body}...`;
}

function sanitizeSummaryForSpeech(summary: string, targetLength: number): string {
  const withoutAssistantScaffolding = sanitizeAssistantVisibleText(summary).trim();
  const withoutPromptBlock = withoutAssistantScaffolding
    .replace(TEXT_TO_SUMMARIZE_PROMPT_BLOCK_RE, "")
    .trim();
  const withoutPromptEcho = stripLeadingSummaryPromptEcho(withoutPromptBlock).trim();
  return truncateSummaryToTargetLength(withoutPromptEcho, targetLength).trim();
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
        .join(" ")
        .trim();
      const sanitizedSummary = sanitizeSummaryForSpeech(summary, targetLength);

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
