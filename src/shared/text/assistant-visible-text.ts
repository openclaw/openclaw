// Assistant visible text helpers strip hidden reasoning and control marker text.
import {
  createPlainTextToolCallBraceProbe,
  projectPlainTextToolCallBlocks,
} from "../../../packages/tool-call-repair/src/payload.js";
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
import { findCodeRegions, projectLinesOutsideCode } from "./code-regions.js";
import { downgradedToolCallTextFilter } from "./downgraded-tool-call-text.js";
import { orderInternalScaffoldingStages } from "./internal-scaffolding-stages.js";
import { modelSpecialTokensTextFilter } from "./model-special-tokens.js";
import { reasoningTagTextFilter } from "./reasoning-tags.js";
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
    let visibleThrough = 0;
    let trailingHighSurrogate = "";
    const projector = createConditionalTextProjector(
      () => "",
      (input) => {
        if (!visible) {
          const appended = trailingHighSurrogate + (input.delta ?? input.text);
          // A split supplementary character cannot permanently establish visibility yet.
          trailingHighSurrogate = /[\uD800-\uDBFF]$/.test(appended) ? appended.slice(-1) : "";
          visible = Boolean(
            stripInvisibleAssistantText(trailingHighSurrogate ? appended.slice(0, -1) : appended),
          );
          if (visible) {
            visibleThrough = input.text.length;
          }
        }
        return !visible;
      },
    );
    projector.canReplaceFrom = (start) => visible && start >= visibleThrough;
    return projector;
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
  const reasoning = reasoningTagTextFilter({
    mode: preserve ? "preserve" : "strict",
    scope: profile === "final-answer-delivery" ? "leading" : "all",
    // An unfinished stream cannot use terminal malformed-output recovery.
    recoverUnclosed: !streaming,
  });
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
    minimaxToolCallTextFilter(streaming),
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
export function minimaxToolCallTextFilter(streaming = false): TextFilter {
  return {
    transform: (text) => stripMinimaxToolCallXml(text, { recoverUnclosed: !streaming }),
    activationTokens: ["minimax:tool_call", "<]minimax[>[<tool_call>"],
  };
}

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

const plainToolCallActivationTokens = ["<parameter=", "<function=", "to="] as const;
function createPlainToolCallTextProjector() {
  const checkpoint: NonNullable<TextFilter["checkpoint"]> = (text, settleBefore, context) =>
    projectPlainTextToolCallBlocks(text, {
      resolveProtectedRanges: context.codeRegions,
      settleBefore,
    });
  const activation = new RegExp(plainToolCallActivationTokens.map(escapeRegExp).join("|"), "i");
  const overlap = Math.max(...plainToolCallActivationTokens.map((token) => token.length - 1));
  const braceProbe = createPlainTextToolCallBraceProbe();
  let active = false;
  let tail = "";
  return createConditionalTextProjector(
    plainToolCallTransform,
    (input) => {
      if (!active) {
        const appended = tail + (input.delta ?? input.text);
        active = activation.test(appended) || braceProbe(input.delta ?? input.text);
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

/**
 * Settlement of a plain-text tool-call candidate at the end of visible text. Streaming may
 * publish that tail and retract it later through a replacement, but block replies
 * (already-delivered chat messages) cannot be retracted, so their drain waits until the
 * candidate settles.
 */
export function hasUnsettledPlainTextToolCall(text: string): boolean {
  if (!text) {
    return false;
  }
  const projected = projectPlainTextToolCallBlocks(text, {
    resolveProtectedRanges: findCodeRegions,
  });
  return projected.unsettled;
}

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
