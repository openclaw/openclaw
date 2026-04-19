import { normalizeLowercaseStringOrEmpty } from "../string-coerce.js";
import { findCodeRegions, isInsideCode } from "./code-regions.js";
import { stripModelSpecialTokens } from "./model-special-tokens.js";
import {
  stripReasoningTagsFromText,
  type ReasoningTagMode,
  type ReasoningTagTrim,
} from "./reasoning-tags.js";

const MEMORY_TAG_RE = /<\s*(\/?)\s*relevant[-_]memories\b[^<>]*>/gi;
const MEMORY_TAG_QUICK_RE = /<\s*\/?\s*relevant[-_]memories\b/i;

/**
 * Strip XML-style tool call tags that models sometimes emit as plain text.
 * This stateful pass hides content from an opening tag through the matching
 * closing tag, or to end-of-string if the stream was truncated mid-tag.
 */
const TOOL_CALL_QUICK_RE =
  /<\s*\/?\s*(?:tool_call|tool_result|function_calls?|function|tool_calls)\b/i;
const TOOL_CALL_TAG_NAMES = new Set([
  "tool_call",
  "tool_result",
  "function_call",
  "function_calls",
  "function",
  "tool_calls",
]);
const TOOL_CALL_JSON_PAYLOAD_START_RE =
  /^(?:\s+[A-Za-z_:][-A-Za-z0-9_:.]*\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))*\s*(?:\r?\n\s*)?[[{]/;
const TOOL_CALL_XML_PAYLOAD_START_RE =
  /^\s*(?:\r?\n\s*)?<(?:function|invoke|parameters?|arguments?)\b/i;

type ToolCallPayloadKind = "json" | "xml" | null;

function endsInsideQuotedString(text: string, start: number, end: number): boolean {
  let quoteChar: "'" | '"' | null = null;
  let isEscaped = false;

  for (let idx = start; idx < end; idx += 1) {
    const char = text[idx];
    if (quoteChar === null) {
      if (char === '"' || char === "'") {
        quoteChar = char;
      }
      continue;
    }

    if (isEscaped) {
      isEscaped = false;
      continue;
    }

    if (char === "\\") {
      isEscaped = true;
      continue;
    }

    if (char === quoteChar) {
      quoteChar = null;
    }
  }

  return quoteChar !== null;
}

interface ParsedToolCallTag {
  contentStart: number;
  end: number;
  isClose: boolean;
  isSelfClosing: boolean;
  tagName: string;
  isTruncated: boolean;
}

function isToolCallBoundary(char: string | undefined): boolean {
  return !char || /\s/.test(char) || char === "/" || char === ">";
}

function findTagCloseIndex(text: string, start: number): number {
  let quoteChar: "'" | '"' | null = null;
  let isEscaped = false;

  for (let idx = start; idx < text.length; idx += 1) {
    const char = text[idx];
    if (quoteChar !== null) {
      if (isEscaped) {
        isEscaped = false;
        continue;
      }
      if (char === "\\") {
        isEscaped = true;
        continue;
      }
      if (char === quoteChar) {
        quoteChar = null;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quoteChar = char;
      continue;
    }
    if (char === "<") {
      return -1;
    }
    if (char === ">") {
      return idx;
    }
  }

  return -1;
}

function detectToolCallPayloadKind(text: string, start: number): ToolCallPayloadKind {
  const rest = text.slice(start);
  if (TOOL_CALL_JSON_PAYLOAD_START_RE.test(rest)) {
    return "json";
  }
  if (TOOL_CALL_XML_PAYLOAD_START_RE.test(rest)) {
    return "xml";
  }
  return null;
}

function isLikelyStandaloneFunctionToolCall(
  text: string,
  tagStart: number,
  tag: ParsedToolCallTag,
): boolean {
  if (tag.tagName !== "function" || tag.isClose || tag.isSelfClosing || tag.isTruncated) {
    return false;
  }

  if (!/\bname\s*=/.test(text.slice(tag.contentStart, tag.end))) {
    return false;
  }

  let idx = tagStart - 1;
  while (idx >= 0 && (text[idx] === " " || text[idx] === "\t")) {
    idx -= 1;
  }

  return idx < 0 || text[idx] === "\n" || text[idx] === "\r" || /[.!?:]/.test(text[idx]);
}

function parseToolCallTagAt(text: string, start: number): ParsedToolCallTag | null {
  if (text[start] !== "<") {
    return null;
  }

  let cursor = start + 1;
  while (cursor < text.length && /\s/.test(text[cursor])) {
    cursor += 1;
  }

  let isClose = false;
  if (text[cursor] === "/") {
    isClose = true;
    cursor += 1;
    while (cursor < text.length && /\s/.test(text[cursor])) {
      cursor += 1;
    }
  }

  const nameStart = cursor;
  while (cursor < text.length && /[A-Za-z_]/.test(text[cursor])) {
    cursor += 1;
  }

  const tagName = normalizeLowercaseStringOrEmpty(text.slice(nameStart, cursor));
  if (!TOOL_CALL_TAG_NAMES.has(tagName) || !isToolCallBoundary(text[cursor])) {
    return null;
  }
  const contentStart = cursor;

  const closeIndex = findTagCloseIndex(text, cursor);
  if (closeIndex === -1) {
    return {
      contentStart,
      end: text.length,
      isClose,
      isSelfClosing: false,
      tagName,
      isTruncated: true,
    };
  }

  return {
    contentStart,
    end: closeIndex + 1,
    isClose,
    isSelfClosing: !isClose && /\/\s*$/.test(text.slice(cursor, closeIndex)),
    tagName,
    isTruncated: false,
  };
}

export function stripToolCallXmlTags(text: string): string {
  if (!text || !TOOL_CALL_QUICK_RE.test(text)) {
    return text;
  }

  const codeRegions = findCodeRegions(text);
  let result = "";
  let lastIndex = 0;
  let inToolCallBlock = false;
  let toolCallBlockContentStart = 0;
  let toolCallBlockNeedsQuoteBalance = false;
  let toolCallBlockStart = 0;
  let toolCallBlockTagName: string | null = null;
  const visibleTagBalance = new Map<string, number>();

  for (let idx = 0; idx < text.length; idx += 1) {
    if (text[idx] !== "<") {
      continue;
    }
    if (!inToolCallBlock && isInsideCode(idx, codeRegions)) {
      continue;
    }

    const tag = parseToolCallTagAt(text, idx);
    if (!tag) {
      continue;
    }

    if (!inToolCallBlock) {
      result += text.slice(lastIndex, idx);
      if (tag.isClose) {
        if (tag.isTruncated) {
          const preserveEnd = tag.contentStart;
          result += text.slice(idx, preserveEnd);
          lastIndex = preserveEnd;
          idx = Math.max(idx, preserveEnd - 1);
          continue;
        }
        const balance = visibleTagBalance.get(tag.tagName) ?? 0;
        if (balance > 0) {
          result += text.slice(idx, tag.end);
          visibleTagBalance.set(tag.tagName, balance - 1);
        }
        lastIndex = tag.end;
        idx = Math.max(idx, tag.end - 1);
        continue;
      }
      if (tag.isSelfClosing) {
        lastIndex = tag.end;
        idx = Math.max(idx, tag.end - 1);
        continue;
      }
      const payloadStart = tag.isTruncated ? tag.contentStart : tag.end;
      const payloadKind =
        tag.tagName === "tool_call" || tag.tagName === "function"
          ? detectToolCallPayloadKind(text, payloadStart)
          : TOOL_CALL_JSON_PAYLOAD_START_RE.test(text.slice(payloadStart))
            ? "json"
            : null;
      const shouldStripStandaloneFunction =
        tag.tagName !== "function" || isLikelyStandaloneFunctionToolCall(text, idx, tag);
      if (!tag.isClose && payloadKind && shouldStripStandaloneFunction) {
        inToolCallBlock = true;
        toolCallBlockContentStart = tag.end;
        toolCallBlockNeedsQuoteBalance = payloadKind === "json";
        toolCallBlockStart = idx;
        toolCallBlockTagName = tag.tagName;
        if (tag.isTruncated) {
          lastIndex = text.length;
          break;
        }
      } else {
        const preserveEnd = tag.isTruncated ? tag.contentStart : tag.end;
        result += text.slice(idx, preserveEnd);
        if (!tag.isTruncated) {
          visibleTagBalance.set(tag.tagName, (visibleTagBalance.get(tag.tagName) ?? 0) + 1);
        }
        lastIndex = preserveEnd;
        idx = Math.max(idx, preserveEnd - 1);
        continue;
      }
    } else if (
      tag.isClose &&
      (tag.tagName === toolCallBlockTagName ||
        (toolCallBlockTagName === "tool_result" && tag.tagName === "tool_call")) &&
      (!toolCallBlockNeedsQuoteBalance ||
        !endsInsideQuotedString(text, toolCallBlockContentStart, idx))
    ) {
      inToolCallBlock = false;
      toolCallBlockNeedsQuoteBalance = false;
      toolCallBlockTagName = null;
    }

    lastIndex = tag.end;
    idx = Math.max(idx, tag.end - 1);
  }

  if (!inToolCallBlock) {
    result += text.slice(lastIndex);
  } else if (toolCallBlockTagName === "function") {
    result += text.slice(toolCallBlockStart);
  }

  return result;
}

/**
 * Strip malformed Minimax tool invocations that leak into text content.
 * Minimax sometimes embeds tool calls as XML in text blocks instead of
 * proper structured tool calls.
 */
export function stripMinimaxToolCallXml(text: string): string {
  if (!text || !/minimax:tool_call/i.test(text)) {
    return text;
  }

  // Remove <invoke ...>...</invoke> blocks (non-greedy to handle multiple).
  let cleaned = text.replace(/<invoke\b[^>]*>[\s\S]*?<\/invoke>/gi, "");

  // Remove stray minimax tool tags.
  cleaned = cleaned.replace(/<\/?minimax:tool_call>/gi, "");

  return cleaned;
}

/**
 * Strip downgraded tool call text representations that leak into user-visible
 * text content when replaying history across providers.
 */
export function stripDowngradedToolCallText(text: string): string {
  if (!text) {
    return text;
  }
  if (!/\[Tool (?:Call|Result)/i.test(text) && !/\[Historical context/i.test(text)) {
    return text;
  }

  const consumeJsonish = (
    input: string,
    start: number,
    options?: { allowLeadingNewlines?: boolean },
  ): number | null => {
    const { allowLeadingNewlines = false } = options ?? {};
    let index = start;
    while (index < input.length) {
      const ch = input[index];
      if (ch === " " || ch === "\t") {
        index += 1;
        continue;
      }
      if (allowLeadingNewlines && (ch === "\n" || ch === "\r")) {
        index += 1;
        continue;
      }
      break;
    }
    if (index >= input.length) {
      return null;
    }

    const startChar = input[index];
    if (startChar === "{" || startChar === "[") {
      let depth = 0;
      let inString = false;
      let escape = false;
      for (let idx = index; idx < input.length; idx += 1) {
        const ch = input[idx];
        if (inString) {
          if (escape) {
            escape = false;
          } else if (ch === "\\") {
            escape = true;
          } else if (ch === '"') {
            inString = false;
          }
          continue;
        }
        if (ch === '"') {
          inString = true;
          continue;
        }
        if (ch === "{" || ch === "[") {
          depth += 1;
        } else if (ch === "}" || ch === "]") {
          depth -= 1;
          if (depth === 0) {
            return idx + 1;
          }
        }
      }
      return null;
    }

    if (startChar === '"') {
      let escape = false;
      for (let idx = index + 1; idx < input.length; idx += 1) {
        const ch = input[idx];
        if (escape) {
          escape = false;
          continue;
        }
        if (ch === "\\") {
          escape = true;
          continue;
        }
        if (ch === '"') {
          return idx + 1;
        }
      }
      return null;
    }

    let end = index;
    while (end < input.length && input[end] !== "\n" && input[end] !== "\r") {
      end += 1;
    }
    return end;
  };

  const stripToolCalls = (input: string): string => {
    const toolCallRe = /\[Tool Call:[^\]]*\]/gi;
    let result = "";
    let cursor = 0;
    for (const match of input.matchAll(toolCallRe)) {
      const start = match.index ?? 0;
      if (start < cursor) {
        continue;
      }
      result += input.slice(cursor, start);
      let index = start + match[0].length;
      while (index < input.length && (input[index] === " " || input[index] === "\t")) {
        index += 1;
      }
      if (input[index] === "\r") {
        index += 1;
        if (input[index] === "\n") {
          index += 1;
        }
      } else if (input[index] === "\n") {
        index += 1;
      }
      while (index < input.length && (input[index] === " " || input[index] === "\t")) {
        index += 1;
      }
      if (normalizeLowercaseStringOrEmpty(input.slice(index, index + 9)) === "arguments") {
        index += 9;
        if (input[index] === ":") {
          index += 1;
        }
        if (input[index] === " ") {
          index += 1;
        }
        const end = consumeJsonish(input, index, { allowLeadingNewlines: true });
        if (end !== null) {
          index = end;
        }
      }
      if (
        (input[index] === "\n" || input[index] === "\r") &&
        (result.endsWith("\n") || result.endsWith("\r") || result.length === 0)
      ) {
        if (input[index] === "\r") {
          index += 1;
        }
        if (input[index] === "\n") {
          index += 1;
        }
      }
      cursor = index;
    }
    result += input.slice(cursor);
    return result;
  };

  // Remove [Tool Call: name (ID: ...)] blocks and their Arguments.
  let cleaned = stripToolCalls(text);

  // Remove [Tool Result for ID ...] blocks and their content.
  cleaned = cleaned.replace(/\[Tool Result for ID[^\]]*\]\n?[\s\S]*?(?=\n*\[Tool |\n*$)/gi, "");

  // Remove [Historical context: ...] markers (self-contained within brackets).
  cleaned = cleaned.replace(/\[Historical context:[^\]]*\]\n?/gi, "");

  return cleaned.trim();
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

export type AssistantVisibleTextSanitizerProfile =
  | "delivery"
  | "history"
  | "internal-scaffolding"
  | "progress";

type AssistantVisibleTextPipelineOptions = {
  finalTrim: ReasoningTagTrim;
  preserveDowngradedToolText?: boolean;
  preserveMinimaxToolXml?: boolean;
  reasoningMode: ReasoningTagMode;
  reasoningTrim: ReasoningTagTrim;
  stageOrder: "reasoning-first" | "reasoning-last";
  // Phase 3 Discord Surface Overhaul: extra leak-scrub passes for
  // progress-class surfaces. These strip absolute filesystem paths, redact
  // common secret patterns (sk-* API keys, Bearer tokens, OpenClaw-shaped
  // secret refs), and trim stack-trace frames that otherwise reveal user
  // home directories and internal module layouts. Kept OFF by default to
  // preserve delivery/history fidelity for final replies.
  stripAbsolutePaths?: boolean;
  redactSecrets?: boolean;
  stripStackTraces?: boolean;
};

const ASSISTANT_VISIBLE_TEXT_PIPELINE_OPTIONS: Record<
  AssistantVisibleTextSanitizerProfile,
  AssistantVisibleTextPipelineOptions
> = {
  delivery: {
    finalTrim: "both",
    reasoningMode: "strict",
    reasoningTrim: "both",
    stageOrder: "reasoning-last",
  },
  history: {
    finalTrim: "none",
    reasoningMode: "strict",
    reasoningTrim: "none",
    stageOrder: "reasoning-last",
  },
  "internal-scaffolding": {
    finalTrim: "start",
    preserveDowngradedToolText: true,
    preserveMinimaxToolXml: true,
    reasoningMode: "preserve",
    reasoningTrim: "start",
    stageOrder: "reasoning-first",
  },
  // Stricter profile for progress-class surfaces (in-thread interim updates,
  // lifecycle notices). Everything `delivery` does, PLUS leak scrubbing.
  progress: {
    finalTrim: "both",
    reasoningMode: "strict",
    reasoningTrim: "both",
    stageOrder: "reasoning-last",
    stripAbsolutePaths: true,
    redactSecrets: true,
    stripStackTraces: true,
  },
};

// Strip absolute filesystem paths that reveal user-home layouts or internal
// server layouts. Both POSIX (`/home/user/...`, `/Users/user/...`,
// `/tmp/...`, `/var/...`, `/opt/...`, `/etc/...`, `/mnt/...`, `/srv/...`)
// and Windows (`C:\Users\user\...`, generic `C:\path\...`) paths are
// normalized to `~/...`. `/root` is treated as a home directory itself since
// it is the root account's home; its suffix is preserved. Kept conservative
// so paths inside quoted code blocks are still recognizable.
// Phase 3.6: the POSIX_SYS prefix list extends past home-dir paths to cover
// common server-layout leaks (`/tmp/secret.txt`, `/etc/passwd`, etc.)
// discovered by the Phase 7 P3 red-team.
const ABS_PATH_POSIX_USER_RE = /\/(?:home|Users)\/[^/\s"'`<>]+(\/[^\s"'`<>]*)?/g;
const ABS_PATH_POSIX_ROOT_RE = /\/root(\/[^\s"'`<>]*)?/g;
// POSIX_SYS uses a negative lookbehind to avoid matching path segments that
// already sit inside a normalized `~/…` path (e.g. the trailing `/tmp/…` of
// an earlier-scrubbed `/home/user/tmp/…`). Anchoring to non-path boundary
// characters keeps the rule specific to top-level absolute paths.
const ABS_PATH_POSIX_SYS_RE = /(?<![~\w.-])\/(?:tmp|var|opt|etc|mnt|srv)(\/[^\s"'`<>]*)?/g;
const ABS_PATH_WIN_RE =
  /[a-zA-Z]:\\(?:Users|Documents and Settings)\\[^\\/\s"'`<>]+(\\[^\s"'`<>]*)?/g;
// Generic Windows drive-letter path (not matched by the user-profile regex).
// Require at least one path segment after the drive so plain drive-letter
// references (e.g. the literal text "C:\") don't get scrubbed; match until
// whitespace/quote terminators.
const ABS_PATH_WIN_GENERIC_RE = /[a-zA-Z]:\\[^\s"'`<>\\]+(?:\\[^\s"'`<>]*)?/g;

function stripAbsolutePathsFromText(text: string): string {
  let cleaned = text.replace(ABS_PATH_POSIX_USER_RE, (_match, tail: string | undefined) => {
    return tail ? `~${tail}` : "~";
  });
  cleaned = cleaned.replace(ABS_PATH_POSIX_ROOT_RE, (_match, tail: string | undefined) => {
    return tail ? `~${tail}` : "~";
  });
  cleaned = cleaned.replace(ABS_PATH_POSIX_SYS_RE, (_match, tail: string | undefined) => {
    return tail ? `~${tail}` : "~";
  });
  cleaned = cleaned.replace(ABS_PATH_WIN_RE, (_match, tail: string | undefined) => {
    return tail ? `~${tail.replace(/\\/g, "/")}` : "~";
  });
  cleaned = cleaned.replace(ABS_PATH_WIN_GENERIC_RE, (match) => {
    // Skip if we already normalized this to `~/...`; the previous passes may
    // have consumed the user-profile form already.
    const tail = match.slice(2); // drop "C:" / drive letter + colon
    return `~${tail.replace(/\\/g, "/")}`;
  });
  return cleaned;
}

// Redact common secret-shaped strings. The patterns are intentionally narrow
// to avoid false positives eating real prose (e.g., "bearer" appears in legal
// text). Each pattern requires a plausible secret-shaped suffix.
const SK_API_KEY_RE = /\bsk-(?:live|test|proj|ant-api\w+-)?[A-Za-z0-9_-]{16,}\b/g;
// Phase 3.6: bearer regex is now case-insensitive so `bearer`, `Bearer`,
// `BEARER` all scrub. The preserved keyword reuses the original casing via
// the captured group so the redacted header looks natural.
const BEARER_TOKEN_RE = /\b(Bearer)\s+[A-Za-z0-9_.\-~+/=]{12,}\b/gi;
const OPENAI_TOKEN_RE = /\bOPENAI_API_KEY\s*=\s*\S+/g;
const ANTHROPIC_TOKEN_RE = /\bANTHROPIC_API_KEY\s*=\s*\S+/g;
const GITHUB_PAT_RE = /\bghp_[A-Za-z0-9]{20,}\b/g;
// Phase 3.6 Gap 2: AWS credentials. Two complementary regexes — one matches
// the explicit env-var assignment form (any `AWS_*KEY|SECRET|TOKEN=value`),
// the other catches bare AKIA-prefixed access-key ids even when they appear
// without a surrounding assignment (e.g. in log lines). Kept narrow to the
// "AWS_"-prefixed names so unrelated `KEY=` assignments are not captured here.
const AWS_ENV_ASSIGN_RE =
  /\b(?:AWS|aws)_[A-Za-z0-9_]*(?:KEY|SECRET|TOKEN|key|secret|token)\s*[:=]\s*["']?[^\s"']+["']?/g;
const AWS_ACCESS_KEY_ID_RE = /\bAKIA[0-9A-Z]{16}\b/g;
// Phase 3.6 Gap 3: Slack tokens. Covers xoxa/xoxb/xoxo/xoxp/xoxr/xoxs.
const SLACK_TOKEN_RE = /\bxox[aboprs]-[A-Za-z0-9-]{10,}\b/g;
// Phase 3.6 Gap 4: generic env assignments whose NAMES contain sensitive
// keywords. Scoped tightly to upper-case identifiers ending in a sensitive
// suffix so that legitimate prose ("my secret recipe") is not caught. The
// negative-lookahead guards against re-redacting values that earlier passes
// (AWS, GitHub PAT, OPENAI, ANTHROPIC) already replaced with a `[redacted…]`
// marker, so specific markers are preserved when both rules would match.
const GENERIC_SECRET_ENV_RE =
  /\b[A-Z][A-Z0-9_]*(?:SECRET|TOKEN|KEY|PASSWORD|PASSWD|CREDENTIAL|PRIVATE_KEY|AUTH|API_KEY)\s*[:=]\s*(?!\[redacted)["']?[^\s"']+["']?/g;
// Phase 3.6 Gap 5: JWTs. Three base64url-encoded segments separated by dots,
// starting with `eyJ` (the base64url encoding of `{"`). The minimum segment
// lengths avoid matching benign strings that happen to start with `eyJ`.
const JWT_RE = /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g;

function redactSecretsFromText(text: string): string {
  let cleaned = text.replace(SK_API_KEY_RE, "[redacted-api-key]");
  // Phase 3.6 Gap 6: case-insensitive bearer. Preserve the original keyword
  // casing so redacted text still reads naturally.
  cleaned = cleaned.replace(BEARER_TOKEN_RE, (_match, keyword: string) => `${keyword} [redacted]`);
  cleaned = cleaned.replace(OPENAI_TOKEN_RE, "OPENAI_API_KEY=[redacted]");
  cleaned = cleaned.replace(ANTHROPIC_TOKEN_RE, "ANTHROPIC_API_KEY=[redacted]");
  cleaned = cleaned.replace(GITHUB_PAT_RE, "[redacted-github-pat]");
  // AWS-specific redactions run BEFORE the generic env assignment pass so the
  // "[redacted-aws-*]" tag is preserved instead of being rewritten by the
  // generic pass (which would produce `=[redacted]`).
  cleaned = cleaned.replace(AWS_ENV_ASSIGN_RE, (match) => {
    const eqIdx = match.search(/[:=]/);
    const name = match.slice(0, eqIdx).trim();
    const sep = match[eqIdx];
    return `${name}${sep}[redacted-aws-secret]`;
  });
  cleaned = cleaned.replace(AWS_ACCESS_KEY_ID_RE, "[redacted-aws-access-key-id]");
  cleaned = cleaned.replace(SLACK_TOKEN_RE, "[redacted-slack-token]");
  cleaned = cleaned.replace(JWT_RE, "[redacted-jwt]");
  // Generic sensitive-name env assignment. Runs LAST so earlier-specific
  // rules (OPENAI/ANTHROPIC/AWS) win their named slots; anything still
  // matching is scrubbed with a generic marker while preserving the key name.
  cleaned = cleaned.replace(GENERIC_SECRET_ENV_RE, (match) => {
    const eqIdx = match.search(/[:=]/);
    const name = match.slice(0, eqIdx).trim();
    const sep = match[eqIdx];
    return `${name}${sep}[redacted]`;
  });
  return cleaned;
}

// Strip stack-trace frames (lines beginning with "    at ..." plus an adjacent
// parenthesized path). Only target the common Node.js format; preserve user
// prose mentioning "at the top" or similar.
const STACK_FRAME_RE = /^\s{2,}at\s+[^\n]*?(?:\([^\n)]*\)|:\d+(?::\d+)?)\s*$/gm;
// Phase 3.6 Gap 7: bare stack frames that a model echoes without the usual
// parenthesised path/line suffix. Requires a clearly-stack-shaped line:
// at least 2 leading spaces of indentation (typical V8 stack output begins
// with 4), literal `at ` token, then a JS identifier — optionally dotted,
// optionally with one `<…>` synthetic frame name (e.g. `Object.<anonymous>`),
// and optionally a trailing argument list `(…)`. The regex refuses to match
// lines where the `at` appears mid-sentence ("walking at a pace") because it
// anchors to leading whitespace + the exact `at ` token followed by an
// identifier-start, not free text.
const BARE_STACK_FRAME_RE =
  /^\s{2,}at\s+[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*|\.<[A-Za-z_$][\w$]*>)*(?:\s*\([^\n)]*\))?\s*$/gm;

function stripStackTracesFromText(text: string): string {
  let cleaned = text.replace(STACK_FRAME_RE, "");
  cleaned = cleaned.replace(BARE_STACK_FRAME_RE, "");
  return cleaned;
}

function applyAssistantVisibleTextStagePipeline(
  text: string,
  options: AssistantVisibleTextPipelineOptions,
): string {
  if (!text) {
    return text;
  }

  const stripReasoning = (value: string) =>
    stripReasoningTagsFromText(value, {
      mode: options.reasoningMode,
      trim: options.reasoningTrim,
    });
  const applyFinalTrim = (value: string) => {
    if (options.finalTrim === "none") {
      return value;
    }
    if (options.finalTrim === "start") {
      return value.trimStart();
    }
    return value.trim();
  };
  const stripNonReasoningStages = (value: string) => {
    let cleaned = value;
    if (!options.preserveMinimaxToolXml) {
      cleaned = stripMinimaxToolCallXml(cleaned);
    }
    cleaned = stripModelSpecialTokens(cleaned);
    cleaned = stripRelevantMemoriesTags(cleaned);
    cleaned = stripToolCallXmlTags(cleaned);
    if (!options.preserveDowngradedToolText) {
      cleaned = stripDowngradedToolCallText(cleaned);
    }
    return cleaned;
  };
  // Phase 3 leak-scrub pass. Runs AFTER the XML / tool-call / memory stripping
  // so redaction operates on prose-only text and won't paste "[redacted]"
  // markers back into a preserved tool-call envelope.
  const applyLeakScrub = (value: string) => {
    let cleaned = value;
    if (options.stripStackTraces) {
      cleaned = stripStackTracesFromText(cleaned);
    }
    if (options.redactSecrets) {
      cleaned = redactSecretsFromText(cleaned);
    }
    if (options.stripAbsolutePaths) {
      cleaned = stripAbsolutePathsFromText(cleaned);
    }
    return cleaned;
  };

  const core =
    options.stageOrder === "reasoning-first"
      ? stripNonReasoningStages(stripReasoning(text))
      : stripReasoning(stripNonReasoningStages(text));

  return applyFinalTrim(applyLeakScrub(core));
}

export function sanitizeAssistantVisibleTextWithProfile(
  text: string,
  profile: AssistantVisibleTextSanitizerProfile = "delivery",
): string {
  return applyAssistantVisibleTextStagePipeline(
    text,
    ASSISTANT_VISIBLE_TEXT_PIPELINE_OPTIONS[profile],
  );
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
