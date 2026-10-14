// Assistant visible text helpers strip hidden reasoning and control marker text.
import { stripPlainTextToolCallBlocks } from "../../../packages/tool-call-repair/src/index.js";
import { findCodeRegions, isInsideCode, stripLinesOutsideCode } from "./code-regions.js";
import { downgradedToolCallTextFilter } from "./downgraded-tool-call-text.js";
import { stripModelSpecialTokens } from "./model-special-tokens.js";
import { stripReasoningTagsFromText } from "./reasoning-tags.js";
import {
  applyTextFilters,
  createConditionalTextProjector,
  leadingEmptyLinesTextFilter,
  trimTextFilter,
  type TextFilter,
} from "./text-projection.js";
import { toolCallXmlTextFilter } from "./tool-call-xml.js";

export { stripToolCallXmlTags, toolCallXmlTextFilter } from "./tool-call-xml.js";

const MEMORY_TAG_RE = /<\s*(\/?)\s*relevant[-_]memories\b[^<>]*>/gi;
const MEMORY_TAG_QUICK_RE = /<\s*\/?\s*relevant[-_]memories\b/i;
const LEGACY_BRACKET_TOOL_BLOCK_QUICK_RE = /\[\s*\/?\s*TOOL_(?:CALL|RESULT)\s*\]/i;
const INTERNAL_TRACE_LINE_QUICK_RE =
  /(?:📊|🛠️|📖|📝|🔍|🔎|⚙️|tool[-_ ]?call|tool[-_ ]?result|function[-_ ]?call)/i;
const INTERNAL_TRACE_LINE_RE =
  /^(?:>\s*)?(?:⚠️\s*)?(?:📊|🛠️|📖|📝|🔍|🔎|⚙️)\s*(?:Session Status|Exec|Read|Edit|Write|Patch|Search|Open|Click|Find|Screenshot|Update Plan|Tool Call|Tool Result|Function Call|Shell|Command)\s*:/i;
// Keep historical tool-warning traces out of replayed prose, including the older
// "(agent) failed" shape. Current warnings use plain tool labels and remain visible.
const INTERNAL_COMPACT_FAILURE_TRACE_LINE_RE =
  /^(?:>\s*)?⚠️\s*🛠️\s+(?:(?:Exec|Bash)\s+failed(?:(?:\s+\(exit\s+-?\d+\))|(?:\s*:[^\r\n]*))?|\S[^\r\n]*\s+\(agent\)`{0,2}\s+failed(?:\s*:[^\r\n]*)?)\s*$/i;
const INTERNAL_COMPACT_COMMAND_TRACE_LINE_RE =
  /^(?:>\s*)?🛠️\s*(?:(?:(?:elevated|pty)\b\s*(?:·|,)\s*)+)?(?:`{1,2}\s*\S|(?:run|check|fetch|pull|push|view|show|list|switch|create|merge|rebase|stage|restore|reset|stash|search|find|print|copy|move|remove|install|start|cd|git|pnpm|npm|yarn|bun|node|python|python3|bash|sh)\b)/i;
const INTERNAL_CHANNEL_TRACE_LINE_RE =
  /^(?:>\s*)?(?:tool[-_ ]?call|tool[-_ ]?result|function[-_ ]?call)\s*[:=]/i;

/**
 * Strip malformed Minimax tool invocations that leak into text content.
 * Minimax sometimes embeds tool calls as XML in text blocks instead of
 * proper structured tool calls.
 */
function stripMinimaxToolCallXml(text: string): string {
  const encodedTransportBoundaryRe = /\]?<\]minimax\[>\[/g;
  const encodedToolCallOpenRe = /\]?<\]minimax\[>\[<tool_call>/g;
  const encodedToolCallCloseRe = /\]?<\]minimax\[>\[<\/tool_call>/g;
  if (!text || (!/minimax:tool_call/i.test(text) && !encodedToolCallOpenRe.test(text))) {
    return text;
  }
  encodedToolCallOpenRe.lastIndex = 0;

  const sourceCodeRegions = findCodeRegions(text);
  let normalized = "";
  let envelopeCursor = 0;
  for (const openMatch of text.matchAll(encodedToolCallOpenRe)) {
    const start = openMatch.index;
    if (start < envelopeCursor || isInsideCode(start, sourceCodeRegions)) {
      continue;
    }

    encodedToolCallCloseRe.lastIndex = start + openMatch[0].length;
    let closeMatch = encodedToolCallCloseRe.exec(text);
    while (closeMatch && isInsideCode(closeMatch.index, sourceCodeRegions)) {
      closeMatch = encodedToolCallCloseRe.exec(text);
    }
    if (!closeMatch) {
      // A later opening cannot find a closing marker once this search reaches the end.
      break;
    }

    const end = closeMatch.index + closeMatch[0].length;
    normalized += text.slice(envelopeCursor, start);
    if (sourceCodeRegions.some((region) => region.start >= start && region.end <= end)) {
      envelopeCursor = end;
      continue;
    }
    normalized += text.slice(start, end).replace(encodedTransportBoundaryRe, "");
    envelopeCursor = end;
  }
  normalized += text.slice(envelopeCursor);

  if (!/minimax:tool_call/i.test(normalized)) {
    return normalized;
  }

  const codeRegions = findCodeRegions(normalized);
  const minimaxToolXmlRe = /<invoke\b[^>]*>[\s\S]*?<\/invoke>|<\/?minimax:tool_call>/gi;
  let result = "";
  let cursor = 0;
  for (const match of normalized.matchAll(minimaxToolXmlRe)) {
    const start = match.index ?? 0;
    if (isInsideCode(start, codeRegions)) {
      continue;
    }
    result += normalized.slice(cursor, start);
    cursor = start + match[0].length;
  }
  result += normalized.slice(cursor);
  return result;
}

function isLegacyBracketToolCallPayload(value: string): boolean {
  return (
    /\btool\s*=>\s*["'][A-Za-z_][A-Za-z0-9_.:-]{0,119}["']/i.test(value) &&
    /\bargs\s*=>/i.test(value)
  );
}

function isLegacyBracketToolResultPayload(value: string): boolean {
  return (
    /^\s*[{[]/.test(value) ||
    /\b(?:tool|result|output|content)\s*=>/i.test(value) ||
    /\b(?:tool|result|output|content)\s*:/i.test(value)
  );
}

export function stripLegacyBracketToolCallBlocks(text: string): string {
  if (!text || !LEGACY_BRACKET_TOOL_BLOCK_QUICK_RE.test(text)) {
    return text;
  }

  const codeRegions = findCodeRegions(text);
  let result = "";
  let cursor = 0;
  for (const openMatch of text.matchAll(/\[\s*TOOL_(CALL|RESULT)\s*\]/gi)) {
    const openStart = openMatch.index;
    if (openStart < cursor || isInsideCode(openStart, codeRegions)) {
      continue;
    }
    const payloadStart = openStart + openMatch[0].length;
    const isResult = openMatch[1]?.toUpperCase() === "RESULT";
    const closeRe = isResult ? /\[\s*\/\s*TOOL_RESULT\s*\]/gi : /\[\s*\/\s*TOOL_CALL\s*\]/gi;
    closeRe.lastIndex = payloadStart;
    const closeMatch = closeRe.exec(text);
    const closeStart =
      closeMatch && !isInsideCode(closeMatch.index, codeRegions) ? closeMatch.index : -1;
    const payload = text.slice(payloadStart, closeStart >= 0 ? closeStart : text.length);
    if (
      !(isResult
        ? isLegacyBracketToolResultPayload(payload)
        : isLegacyBracketToolCallPayload(payload))
    ) {
      continue;
    }
    result += text.slice(cursor, openStart);
    cursor = closeStart >= 0 ? closeStart + (closeMatch?.[0].length ?? 0) : text.length;
    if (cursor === text.length) {
      break;
    }
  }
  return result + text.slice(cursor);
}

function stripRelevantMemoriesTags(text: string): string {
  if (!text || !MEMORY_TAG_QUICK_RE.test(text)) {
    return text;
  }
  MEMORY_TAG_RE.lastIndex = 0;

  const codeRegions = findCodeRegions(text);
  let result = "";
  let lastIndex = 0;
  let inMemoryBlock = false;

  for (const match of text.matchAll(MEMORY_TAG_RE)) {
    const idx = match.index ?? 0;
    if (isInsideCode(idx, codeRegions)) {
      continue;
    }

    const isClose = match[1] === "/";
    if (!inMemoryBlock) {
      result += text.slice(lastIndex, idx);
      if (!isClose) {
        inMemoryBlock = true;
      }
    } else if (isClose) {
      inMemoryBlock = false;
    }

    lastIndex = idx + match[0].length;
  }

  if (!inMemoryBlock) {
    result += text.slice(lastIndex);
  }

  return result;
}

function stripAssistantInternalTraceLines(text: string): string {
  if (!text || !INTERNAL_TRACE_LINE_QUICK_RE.test(text)) {
    return text;
  }

  return stripLinesOutsideCode(text, (line) => {
    const trimmed = line.trim();
    return (
      INTERNAL_TRACE_LINE_RE.test(trimmed) ||
      INTERNAL_COMPACT_FAILURE_TRACE_LINE_RE.test(trimmed) ||
      INTERNAL_COMPACT_COMMAND_TRACE_LINE_RE.test(trimmed) ||
      INTERNAL_CHANNEL_TRACE_LINE_RE.test(trimmed)
    );
  });
}

export type AssistantVisibleTextSanitizerProfile =
  | "delivery"
  | "final-answer-delivery"
  | "history"
  | "internal-scaffolding"
  | "tool-progress";

const profileFilters = new Map<string, readonly TextFilter[]>();

function stripInvisibleAssistantText(text: string): string {
  return /^[\p{White_Space}\p{Default_Ignorable_Code_Point}]*$/u.test(text) ? "" : text;
}

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
  const reasoning: TextFilter = {
    activationTokens: ["<"],
    transform: (text) =>
      stripReasoningTagsFromText(text, {
        mode: preserve ? "preserve" : "strict",
        scope: profile === "final-answer-delivery" ? "leading" : "all",
        trim: preserveCodeIndentation ? "none" : trim,
        // An unfinished stream cannot use terminal malformed-output recovery.
        recoverUnclosed: !streaming,
      }),
  };
  const filters: TextFilter[] = [
    ...(!preserve ? [minimaxToolCallTextFilter] : []),
    { transform: stripModelSpecialTokens, activationTokens: ["<|", "<｜"] },
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
    ...(!preserve ? [downgradedToolCallTextFilter(options)] : []),
  ];
  if (preserve) {
    filters.unshift(reasoning);
  } else {
    filters.push(reasoning);
  }
  filters.push(
    preserve ? leadingEmptyLinesTextFilter : trimTextFilter(trim, { preserveCodeIndentation }),
    {
      transform: stripInvisibleAssistantText,
      create: () => createConditionalTextProjector(stripInvisibleAssistantText, () => true),
    },
  );
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
  activationTokens: ["tool", "function", "📊", "🛠", "📖", "📝", "🔍", "🔎", "⚙"],
};

export const plainToolCallTextFilter: TextFilter = {
  transform: (text) =>
    stripPlainTextToolCallBlocks(text, { resolveProtectedRanges: findCodeRegions }),
  activationTokens: ["[", "<function=", "to="],
};

export function sanitizeAssistantVisibleTextWithProfile(
  text: string,
  profile: AssistantVisibleTextSanitizerProfile = "delivery",
  streaming = false,
): string {
  return applyTextFilters(text, assistantVisibleTextFilters(profile, streaming));
}

export function stripAssistantInternalScaffolding(text: string): string {
  return sanitizeAssistantVisibleTextWithProfile(text, "internal-scaffolding");
}

/**
 * Canonical user-visible assistant text sanitizer for delivery and history
 * extraction paths. Keeps prose, removes internal scaffolding.
 */
export function sanitizeAssistantVisibleText(text: string): string {
  return sanitizeAssistantVisibleTextWithProfile(text, "delivery");
}

/** Sanitizes text already marked as final-answer prose by the agent runtime. */
export function sanitizeAssistantFinalAnswerText(text: string): string {
  return sanitizeAssistantVisibleTextWithProfile(text, "final-answer-delivery");
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
