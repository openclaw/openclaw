// Assistant visible text helpers strip hidden reasoning and control marker text.
import {
  createPlainTextToolCallBraceProbe,
  projectPlainTextToolCallBlocks,
} from "../../../packages/tool-call-repair/src/payload.js";
import { escapeRegExp } from "../regexp.js";
import {
  scanMinimaxToolCallXml,
  stripMinimaxToolCallXml,
  scanRelevantMemoriesTags,
  stripAssistantInternalTraceLines,
  stripLegacyBracketToolCallBlocks,
  scanLegacyBracketToolCallBlocks,
  plainToolCallTransform,
  stripInvisibleAssistantText,
  traceLineHeads,
  INTERNAL_TRACE_LINE_RE,
} from "./assistant-text-transforms.js";
import {
  findCodeRegions,
  isInsideSettledBlockCode,
  projectLinesOutsideCode,
} from "./code-regions.js";
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
  type TextProjector,
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

// Normalize the carried tail and the incoming delta together, so whitespace runs
// spanning many appends collapse into one char instead of pushing the opening ``<``
// out of the bounded tail. ``shape`` and the optional ``requires`` marker are latched
// independently: the canonical MiniMax transform needs its marker anywhere in the
// accumulated text, so the invocation shape may arrive first. A bare mention alone
// satisfies neither shape nor marker (when required) and stays off the re-scan.
// One char after a shape match is required to confirm a delta-split word boundary.
type IncrementalTagScan = {
  text: string;
  suppressRawAppends?: boolean;
  rescanWhileSuppressed?: boolean;
};

function createBoundedTagProjector(
  transform: (text: string) => string,
  shape: RegExp,
  requires?: RegExp,
  scan?: (text: string) => IncrementalTagScan,
): TextProjector {
  let probeTail = "";
  let markerSeen = !requires;
  let shapeSeen = false;
  let active = false;
  let text = "";
  let suppressRawAppends = false;
  let rescanWhileSuppressed = false;
  let codeSyntax = false;
  let sourceTail = "";
  const runCanonical = (source: string) => {
    const projected = scan?.(source) ?? { text: transform(source) };
    text = projected.text;
    suppressRawAppends = projected.suppressRawAppends ?? false;
    rescanWhileSuppressed = projected.rescanWhileSuppressed ?? false;
    codeSyntax ||= /[`~]|\t| {4}/u.test(source);
    sourceTail = source.slice(-3);
  };
  const observe = (source: string) => {
    const joined = (probeTail + source).toLowerCase().replace(/\s+/g, " ");
    if (requires?.test(joined)) {
      markerSeen = true;
    }
    const match = shape.exec(joined);
    if (
      (match && match.index + match[0].length < joined.length) ||
      joined.endsWith("<]minimax[>[")
    ) {
      shapeSeen = true;
    }
    probeTail = joined.slice(-32);
    active = markerSeen && shapeSeen;
  };
  return (input) => {
    const previousText = text;
    if (input.delta === "") {
      return text === input.text ? input : { text, delta: "" };
    }
    if (input.delta === null) {
      probeTail = "";
      markerSeen = !requires;
      shapeSeen = false;
      active = false;
      observe(input.text);
      if (!active) {
        text = input.text;
        suppressRawAppends = false;
        rescanWhileSuppressed = false;
        codeSyntax = /[`~]|\t| {4}/u.test(input.text);
        sourceTail = input.text.slice(-3);
        return input;
      }
      runCanonical(input.text);
      return { text, delta: null };
    }
    if (!active) {
      observe(input.delta);
      if (!active) {
        text = input.text;
        return input;
      }
      runCanonical(input.text);
    } else {
      const codeChanged =
        /[`~]|\t| {4}/u.test(sourceTail + input.delta) ||
        (codeSyntax && /[\x5b\x5d()<>"'\\]/u.test(input.delta));
      codeSyntax ||= /[`~]|\t| {4}/u.test(sourceTail + input.delta);
      if (
        rescanWhileSuppressed ||
        input.delta.includes("<") ||
        input.delta.includes(">") ||
        codeChanged
      ) {
        runCanonical(input.text);
      } else if (!suppressRawAppends) {
        text += input.delta;
        sourceTail = input.text.slice(-3);
      } else {
        sourceTail = input.text.slice(-3);
      }
    }
    if (text.startsWith(previousText)) {
      const nextDelta = text.slice(previousText.length);
      return text === input.text && nextDelta === input.delta ? input : { text, delta: nextDelta };
    }
    return { text, delta: null };
  };
}

const memoriesShape = /<\s*\/?\s*relevant[-_]memories\b/;
const memoriesTextFilter: TextFilter = {
  transform: (text) => scanRelevantMemoriesTags(text).text,
  create: () =>
    createBoundedTagProjector(
      (text) => scanRelevantMemoriesTags(text).text,
      memoriesShape,
      undefined,
      (source) => {
        const scanned = scanRelevantMemoriesTags(source);
        return { text: scanned.text, suppressRawAppends: scanned.inMemoryBlock };
      },
    ),
};

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
      memories: memoriesTextFilter,
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
    memoriesTextFilter,
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
// The canonical transform also removes completed <invoke> blocks whenever the
// ``minimax:tool_call`` marker occurs, even without an exact envelope token, so
// activation needs that marker plus an invocation/tag shape. A bare mention alone
// has no such shape and stays off the whole-reply re-scan.
const encodedMinimaxBoundary = escapeRegExp("<]minimax[>[");
const encodedMinimaxOpen = escapeRegExp("<]minimax[>[<tool_call>");
const minimaxShape = new RegExp(`<invoke\\b|<\\/?minimax:tool_call|${encodedMinimaxBoundary}`);
const minimaxRequires = new RegExp(
  `minimax:tool_call|${encodedMinimaxBoundary}|${encodedMinimaxOpen}`,
);
export function minimaxToolCallTextFilter(streaming = false): TextFilter {
  const transform = (text: string) =>
    stripMinimaxToolCallXml(text, { recoverUnclosed: !streaming });
  return {
    transform,
    create: () =>
      createBoundedTagProjector(transform, minimaxShape, minimaxRequires, (source) => {
        const scanned = scanMinimaxToolCallXml(source, { recoverUnclosed: !streaming });
        return {
          text: scanned.text,
          suppressRawAppends: scanned.pending,
          rescanWhileSuppressed: scanned.rescanWhileSuppressed,
        };
      }),
  };
}

export const legacyBracketToolCallTextFilter: TextFilter = {
  transform: stripLegacyBracketToolCallBlocks,
  activationTokens: ["TOOL_CALL", "TOOL_RESULT"],
  checkpoint(text, boundary, context) {
    const regions = context.codeRegions();
    const scan = scanLegacyBracketToolCallBlocks(text, regions);
    const prefix = scanLegacyBracketToolCallBlocks(text.slice(0, boundary), regions);
    const retainStart = scan.pending || prefix.pending ? 0 : boundary;
    return {
      text: scan.text,
      retainStart,
      retainedOutputStart: retainStart ? prefix.text.length : 0,
    };
  },
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
function createPlainToolCallTextProjector(preview = false) {
  const checkpoint: NonNullable<TextFilter["checkpoint"]> = (text, settleBefore, context) =>
    projectPlainTextToolCallBlocks(text, {
      resolveProtectedRanges: context.codeRegions,
      settleBefore,
      preview,
      isProtectionSettled: (offset) =>
        offset < settleBefore || isInsideSettledBlockCode(offset, text, context.codeRegions()),
    });
  const activation = new RegExp(plainToolCallActivationTokens.map(escapeRegExp).join("|"), "i");
  const overlap = Math.max(...plainToolCallActivationTokens.map((token) => token.length - 1));
  const braceProbe = createPlainTextToolCallBraceProbe(preview);
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

/** Channel previews share the call grammar, but cannot expose its provisional tail. */
export const plainToolCallPreviewTextFilter: TextFilter = {
  transform: plainToolCallTransform,
  create: () => createPlainToolCallTextProjector(true),
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
