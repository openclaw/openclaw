import { scanFenceSpans } from "../../../packages/markdown-core/src/fences.js";
// Assistant visible text helpers strip hidden reasoning and control marker text.
import { projectPlainTextToolCallBlocks } from "../../../packages/tool-call-repair/src/payload.js";
import { escapeRegExp } from "../regexp.js";
import {
  stripMinimaxToolCallXml,
  stripRelevantMemoriesTags,
  stripAssistantInternalTraceLines,
  stripLegacyBracketToolCallBlocks,
  plainToolCallTransform,
  stripInvisibleAssistantText,
  traceLineHeads,
  INTERNAL_TRACE_LINE_RE,
} from "./assistant-text-transforms.js";
import {
  canReuseMarkdownOwnership,
  findCodeOwnership,
  findCodeRegions,
  projectLinesOutsideCode,
} from "./code-regions.js";
import { downgradedToolCallTextFilter } from "./downgraded-tool-call-text.js";
import { orderInternalScaffoldingStages } from "./internal-scaffolding-stages.js";
import { modelSpecialTokensTextFilter } from "./model-special-tokens.js";
import { createReasoningTagProbe, stripReasoningTagsFromText } from "./reasoning-tags.js";
import {
  applyTextFilters,
  createConditionalTextProjector,
  leadingEmptyLinesTextFilter,
  trimTextFilter,
  type TextFilter,
} from "./text-projection.js";
import { toolCallXmlTextFilter } from "./tool-call-xml.js";

export { stripAssistantInternalScaffolding } from "./assistant-internal-scaffolding.js";
export { stripToolCallXmlTags, toolCallXmlTextFilter } from "./tool-call-xml.js";

export type AssistantVisibleTextSanitizerProfile =
  | "delivery"
  | "final-answer-delivery"
  | "history"
  | "internal-scaffolding"
  | "tool-progress";

const invisibleTextFilter: TextFilter = {
  transform: stripInvisibleAssistantText,
  create: () => {
    let visible = false;
    let trailingHighSurrogate = "";
    return createConditionalTextProjector(
      () => "",
      (input) => {
        if (!visible) {
          const appended = trailingHighSurrogate + (input.delta ?? input.text);
          // A split supplementary character cannot permanently establish visibility yet.
          trailingHighSurrogate = /[\uD800-\uDBFF]$/.test(appended) ? appended.slice(-1) : "";
          visible = Boolean(
            stripInvisibleAssistantText(trailingHighSurrogate ? appended.slice(0, -1) : appended),
          );
        }
        return !visible;
      },
    );
  },
};

const profileFilters = new Map<string, readonly TextFilter[]>();

export function assistantVisibleTextFilters(
  profile: AssistantVisibleTextSanitizerProfile,
  streaming = false,
  options?: { preserveTrailingWhitespace?: boolean },
): readonly TextFilter[] {
  const key = `${profile}:${streaming}:${Boolean(options?.preserveTrailingWhitespace)}`;
  const cached = profileFilters.get(key);
  if (cached) {
    return cached;
  }
  const preserve = profile === "internal-scaffolding";
  const preserveCodeIndentation = profile === "delivery" || profile === "final-answer-delivery";
  const trim =
    preserve || profile === "history"
      ? "none"
      : options?.preserveTrailingWhitespace
        ? "start"
        : "both";
  const stripReasoning = (text: string) =>
    stripReasoningTagsFromText(text, {
      mode: preserve ? "preserve" : "strict",
      scope: profile === "final-answer-delivery" ? "leading" : "all",
      trim: preserveCodeIndentation ? "none" : trim,
      // An unfinished stream cannot use terminal malformed-output recovery.
      recoverUnclosed: !streaming,
    });
  const reasoning: TextFilter = {
    transform: stripReasoning,
    create: () => createConditionalTextProjector(stripReasoning, createReasoningTagProbe()),
  };
  if (preserve) {
    const filters = orderInternalScaffoldingStages<TextFilter>({
      reasoning,
      modelTokens: modelSpecialTokensTextFilter,
      memories: {
        transform: stripRelevantMemoriesTags,
        activationTokens: ["relevant-memories", "relevant_memories"],
      },
      xml: toolCallXmlTextFilter({}, streaming),
      trace: assistantTraceTextFilter,
      legacy: legacyBracketToolCallTextFilter,
      plain: plainToolCallTextFilter,
      leading: leadingEmptyLinesTextFilter,
      invisible: invisibleTextFilter,
    });
    profileFilters.set(key, filters);
    return filters;
  }
  const filters: TextFilter[] = [
    minimaxToolCallTextFilter,
    modelSpecialTokensTextFilter,
    {
      transform: stripRelevantMemoriesTags,
      activationTokens: ["relevant-memories", "relevant_memories"],
    },
    toolCallXmlTextFilter(
      {
        stripFunctionCallsXmlPayloads: profile === "tool-progress",
        stripFunctionResponseAfterPluralToolCalls:
          profile === "delivery" || profile === "final-answer-delivery",
      },
      streaming,
    ),
    ...(profile === "tool-progress" ? [] : [assistantTraceTextFilter]),
    legacyBracketToolCallTextFilter,
    plainToolCallTextFilter,
    downgradedToolCallTextFilter(options),
  ];
  filters.push(reasoning);
  filters.push(trimTextFilter(trim, { preserveCodeIndentation }), invisibleTextFilter);
  profileFilters.set(key, filters);
  return filters;
}

// Activation is a necessary condition only; the canonical parsers still own
// syntax, code protection, and later corrections once a marker has appeared.
export const minimaxToolCallTextFilter: TextFilter = {
  transform: stripMinimaxToolCallXml,
  activationTokens: ["minimax:tool_call", "<]minimax[>[<tool_call>"],
};

export const legacyBracketToolCallTextFilter: TextFilter = {
  transform: stripLegacyBracketToolCallBlocks,
  activationTokens: ["TOOL_CALL", "TOOL_RESULT"],
};

export const assistantTraceTextFilter: TextFilter = {
  transform: stripAssistantInternalTraceLines,
  create() {
    let active = false;
    const resetLine = () => traceLineHeads.map((parts) => ({ parts, part: 0, offset: 0 }));
    let candidates = resetLine();
    return createConditionalTextProjector(
      stripAssistantInternalTraceLines,
      (input) => {
        if (active) {
          return true;
        }
        const appended = input.delta ?? input.text;
        for (let at = 0; at < appended.length; at++) {
          const char = appended.charAt(at).toLowerCase();
          if (char === "\n") {
            candidates = resetLine();
            continue;
          }
          const whitespace = /\s/.test(char);
          candidates = candidates.filter((candidate) => {
            if (candidate.offset === 0 && whitespace) {
              return true;
            }
            if (candidate.parts[candidate.part]?.charAt(candidate.offset) !== char) {
              return false;
            }
            candidate.offset++;
            if (candidate.offset === candidate.parts[candidate.part]?.length) {
              candidate.part++;
              candidate.offset = 0;
              active ||= candidate.part === candidate.parts.length;
            }
            return true;
          });
          // The canonical transform owns code protection and corrections after activation.
          if (active) {
            return true;
          }
          if (candidates.length === 0) {
            const newline = appended.indexOf("\n", at + 1);
            if (newline === -1) {
              break;
            }
            at = newline - 1;
          }
        }
        return false;
      },
      (text, retainStart) =>
        projectLinesOutsideCode(
          text,
          (line) => INTERNAL_TRACE_LINE_RE.test(line.trim()),
          retainStart,
        ),
    );
  },
};

const plainToolCallActivationTokens = ["{", "<parameter=", "<function=", "to="] as const;
function createAppendCodeRegionResolver() {
  const isIndentedCodeLine = (line: string) => /^(?: {4}|\t)/u.test(line);
  const hasOpenIndentedCodeLine = (
    text: string,
    regions: ReturnType<typeof findCodeRegions> | undefined,
  ) => {
    const last = regions?.at(-1);
    if (!last?.block || last.end !== text.length) {
      return false;
    }
    const blockLineStart =
      Math.max(text.lastIndexOf("\n", last.start - 1), text.lastIndexOf("\r", last.start - 1)) + 1;
    const nextLineFeed = text.indexOf("\n", blockLineStart);
    const nextCarriageReturn = text.indexOf("\r", blockLineStart);
    const blockLineEnd = Math.min(
      ...[nextLineFeed, nextCarriageReturn].filter((offset) => offset >= 0),
      text.length,
    );
    const currentLineStart = Math.max(text.lastIndexOf("\n"), text.lastIndexOf("\r")) + 1;
    return (
      isIndentedCodeLine(text.slice(blockLineStart, blockLineEnd)) &&
      isIndentedCodeLine(text.slice(currentLineStart))
    );
  };
  let source = "";
  let regions: ReturnType<typeof findCodeRegions> | undefined;
  let ownership: ReturnType<typeof findCodeOwnership> | undefined;
  let openFence = false;
  let openIndentedCodeLine = false;
  let openUntrackedBlock = false;
  return (text: string) => {
    if (regions && canReuseMarkdownOwnership(source, text, ownership)) {
      if (openFence && regions.length > 0) {
        const last = regions[regions.length - 1];
        if (last?.block && last.end === source.length) {
          regions = [...regions.slice(0, -1), { ...last, end: text.length }];
        }
        source = text;
        return regions;
      } else if (openIndentedCodeLine) {
        const lineBreaks = [...text.slice(source.length).matchAll(/\r\n|\r|\n/gu)];
        const hasContentAfterLineBreak = lineBreaks.some(
          (match) => (match.index ?? 0) + match[0].length < text.length - source.length,
        );
        const last = regions[regions.length - 1];
        if (!hasContentAfterLineBreak && last?.block && last.end === source.length) {
          regions = [...regions.slice(0, -1), { ...last, end: text.length }];
          source = text;
          openIndentedCodeLine = !/(?:\r\n|\r|\n)$/u.test(text);
          return regions;
        }
      } else if (!openUntrackedBlock) {
        source = text;
        return regions;
      }
    }
    source = text;
    ownership = /[`~\t]| {4}/u.test(text) ? findCodeOwnership(text) : undefined;
    regions = ownership?.regions ?? [];
    const last = regions.at(-1);
    const lineStart = last
      ? Math.max(text.lastIndexOf("\n", last.start - 1), text.lastIndexOf("\r", last.start - 1)) + 1
      : 0;
    const isTopLevelFence = Boolean(last && /^ {0,3}$/u.test(text.slice(lineStart, last.start)));
    const openFenceScan =
      last?.block && last.end === text.length && isTopLevelFence
        ? scanFenceSpans(text.slice(last.start))
        : undefined;
    openFence = Boolean(openFenceScan?.state.open && openFenceScan.spans.at(-1)?.start === 0);
    openIndentedCodeLine = hasOpenIndentedCodeLine(text, regions);
    openUntrackedBlock = Boolean(
      !openFence && !openIndentedCodeLine && last?.block && last.end === text.length,
    );
    return regions;
  };
}

function createPlainToolCallTextProjector() {
  const resolveProtectedRanges = createAppendCodeRegionResolver();
  const checkpoint = (text: string, settleBefore: number) =>
    projectPlainTextToolCallBlocks(text, { resolveProtectedRanges, settleBefore });
  const activation = new RegExp(plainToolCallActivationTokens.map(escapeRegExp).join("|"), "i");
  const overlap = Math.max(...plainToolCallActivationTokens.map((token) => token.length - 1));
  let active = false;
  let tail = "";
  return createConditionalTextProjector(
    plainToolCallTransform,
    (input) => {
      if (!active) {
        const appended = tail + (input.delta ?? input.text);
        active = activation.test(appended);
        tail = !active && overlap ? appended.slice(-overlap) : "";
      }
      return active;
    },
    checkpoint,
  );
}

export const plainToolCallTextFilter: TextFilter = {
  transform: plainToolCallTransform,
  create: createPlainToolCallTextProjector,
};

export function sanitizeAssistantVisibleTextWithProfile(
  text: string,
  profile: AssistantVisibleTextSanitizerProfile = "delivery",
  streaming = false,
): string {
  return applyTextFilters(text, assistantVisibleTextFilters(profile, streaming));
}

/**
 * Canonical user-visible assistant text sanitizer for delivery and history
 * extraction paths. Keeps prose, removes internal scaffolding.
 */
export function sanitizeAssistantVisibleText(text: string): string {
  return sanitizeAssistantVisibleTextWithProfile(text, "delivery");
}

/**
 * Backwards-compatible trim wrapper.
 * Prefer sanitizeAssistantVisibleTextWithProfile for new call sites.
 */
export function sanitizeAssistantVisibleTextWithOptions(
  text: string,
  options?: { trim?: "none" | "both" },
): string {
  const profile = options?.trim === "none" ? "history" : "delivery";
  return sanitizeAssistantVisibleTextWithProfile(text, profile);
}
