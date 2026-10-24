import { scanFenceSpans } from "../../../packages/markdown-core/src/fences.js";
// Assistant visible text helpers strip hidden reasoning and control marker text.
import {
  projectPlainTextToolCallBlocks,
  stripPlainTextToolCallBlocks,
} from "../../../packages/tool-call-repair/src/index.js";
import { escapeRegExp } from "../regexp.js";
import {
  canReuseMarkdownOwnership,
  findCodeOwnership,
  findCodeRegions,
  isInsideCode,
  projectLinesOutsideCode,
  stripLinesOutsideCode,
} from "./code-regions.js";
import { downgradedToolCallTextFilter } from "./downgraded-tool-call-text.js";
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

export { stripToolCallXmlTags, toolCallXmlTextFilter } from "./tool-call-xml.js";

const MEMORY_TAG_RE = /<\s*(\/?)\s*relevant[-_]memories\b[^<>]*>/gi;
const MEMORY_TAG_QUICK_RE = /<\s*\/?\s*relevant[-_]memories\b/i;
const LEGACY_BRACKET_TOOL_BLOCK_QUICK_RE = /\[\s*\/?\s*TOOL_(?:CALL|RESULT)\s*\]/i;
const traceIconHeads = ["📊", "🛠️", "📖", "📝", "🔍", "🔎", "⚙️"].flatMap((icon) => [
  [icon],
  ["⚠️", icon],
]);
const traceChannelHeads = ["tool call", "tool result", "function call"].flatMap((name) =>
  ["", "-", "_", " "].flatMap((separator) =>
    [":", "="].map((delimiter) => [name.replace(" ", separator), delimiter]),
  ),
);
// Literal head parts, separated by optional whitespace, own both batch and stream activation.
const traceLineRules = [
  {
    heads: traceIconHeads,
    body: /\s*(?:Session Status|Exec|Read|Edit|Write|Patch|Search|Open|Click|Find|Screenshot|Update Plan|Tool Call|Tool Result|Function Call|Shell|Command)\s*:/,
  },
  {
    // Historical warnings include the older "(agent) failed" shape.
    heads: [["⚠️", "🛠️"]],
    body: /\s+(?:(?:Exec|Bash)\s+failed(?:(?:\s+\(exit\s+-?\d+\))|(?:\s*:[^\r\n]*))?|\S[^\r\n]*\s+\(agent\)`{0,2}\s+failed(?:\s*:[^\r\n]*)?)\s*$/,
  },
  {
    heads: [["🛠️"]],
    body: /\s*(?:(?:(?:elevated|pty)\b\s*(?:·|,)\s*)+)?(?:`{1,2}\s*\S|(?:run|check|fetch|pull|push|view|show|list|switch|create|merge|rebase|stage|restore|reset|stash|search|find|print|copy|move|remove|install|start|cd|git|pnpm|npm|yarn|bun|node|python|python3|bash|sh)\b)/,
  },
  { heads: traceChannelHeads, body: /(?:)/ },
];
const INTERNAL_TRACE_LINE_RE = new RegExp(
  `^(?:>\\s*)?(?:${traceLineRules
    .map(
      ({ heads, body }) =>
        `(?:${heads.map((parts) => parts.map(escapeRegExp).join("\\s*")).join("|")})${body.source}`,
    )
    .join("|")})`,
  "i",
);
const traceLineHeads = traceLineRules.flatMap(({ heads }) =>
  heads.flatMap((parts) => [parts, [">", ...parts]]),
);
const INTERNAL_TRACE_HEAD_RE = new RegExp(
  `^[^\\S\\r\\n]*(?:${traceLineHeads
    .map((parts) => parts.map(escapeRegExp).join("\\s*"))
    .join("|")})`,
  "im",
);

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

function stripLegacyBracketToolCallBlocks(text: string): string {
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
    let closeMatch = closeRe.exec(text);
    while (closeMatch && isInsideCode(closeMatch.index, codeRegions)) {
      closeMatch = closeRe.exec(text);
    }
    const payload = text.slice(payloadStart, closeMatch?.index);
    const isToolPayload = isResult
      ? /^\s*[{[]/.test(payload) ||
        /\b(?:tool|result|output|content)\s*=>/i.test(payload) ||
        /\b(?:tool|result|output|content)\s*:/i.test(payload)
      : /\btool\s*=>\s*["'][A-Za-z_][A-Za-z0-9_.:-]{0,119}["']/i.test(payload) &&
        /\bargs\s*=>/i.test(payload);
    if (!isToolPayload) {
      continue;
    }
    result += text.slice(cursor, openStart);
    cursor = closeMatch ? closeMatch.index + closeMatch[0].length : text.length;
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
  // Every removable line contains a canonical head, even when whitespace precedes it.
  if (!INTERNAL_TRACE_HEAD_RE.test(text)) {
    return text;
  }
  return stripLinesOutsideCode(text, (line) => INTERNAL_TRACE_LINE_RE.test(line.trim()));
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
  const filters: TextFilter[] = [
    ...(!preserve ? [minimaxToolCallTextFilter] : []),
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
                stripInvisibleAssistantText(
                  trailingHighSurrogate ? appended.slice(0, -1) : appended,
                ),
              );
            }
            return !visible;
          },
        );
      },
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
const plainToolCallTransform = (text: string) =>
  stripPlainTextToolCallBlocks(text, { resolveProtectedRanges: findCodeRegions });

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
