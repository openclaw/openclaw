import { sanitizeUserFacingText } from "../../agents/pi-embedded-helpers.js";
import { hasReplyPayloadContent } from "../../interactive/payload.js";
import { stripHeartbeatToken } from "../heartbeat.js";
import {
  HEARTBEAT_TOKEN,
  isSilentReplyText,
  SILENT_REPLY_TOKEN,
  stripSilentToken,
} from "../tokens.js";
import type { ReplyPayload } from "../types.js";
import { hasLineDirectives, parseLineDirectives } from "./line-directives.js";
import {
  resolveResponsePrefixTemplate,
  type ResponsePrefixContext,
} from "./response-prefix-template.js";
import { hasSlackDirectives, parseSlackDirectives } from "./slack-directives.js";

/**
 * Strips leaked chain-of-thought / reasoning text that some models (e.g. GLM 4.7)
 * accidentally include in the assistant text instead of keeping it in a separate
 * `thinking` content block.
 *
 * Handles:
 *  - XML-wrapped blocks: <think>…</think>, <thinking>…</thinking>, <reasoning>…</reasoning>
 *  - Inline thinking prefixes like "Let me think about this..." that precede the real answer.
 */
const THINKING_BLOCK_RE =
  /<(?:think|thinking|reasoning|internal_thoughts|chain_of_thought|reflection)>[\s\S]*?<\/(?:think|thinking|reasoning|internal_thoughts|chain_of_thought|reflection)>/gi;

// Catches untagged chain-of-thought leaked by GLM 4.7, Qwen, DeepSeek etc.
// Patterns: "Okay, so the user wants...", "Let me think about...", "The user is asking..."
const THINKING_PREFIX_RE =
  /^(?:(?:okay|ok|alright|right|so|well|hmm|let me)[,.]?\s+)*(?:(?:so\s+)?(?:the\s+)?user\s+(?:is asking|wants|asked|said|has asked|is requesting|seems to|appears to|needs|would like)\b.*?\n+)+/i;

// Catches "Let me think/analyze/consider..." preambles before the real answer
const LET_ME_THINK_RE =
  /^(?:(?:okay|ok|alright|sure|right)[,.]?\s+)?let me\s+(?:think|analyze|consider|figure|work|break|look|check|plan|reason)\b[^]*?\n\n/i;

// Catches leaked tool-call XML that some models (GLM 4.7, Qwen) emit as plain text
// instead of structured tool_use blocks. Matches <arg_key>…</arg_key><arg_value>…</arg_value>,
// <tool_call>…</tool_call>, <function_call>…</function_call>, etc.
const TOOL_CALL_LEAK_RE =
  /<(?:arg_key|arg_value|tool_call|function_call|tool_use|parameters|arguments)>[\s\S]*?<\/(?:arg_key|arg_value|tool_call|function_call|tool_use|parameters|arguments)>/gi;

export function stripThinkingTextLeaks(text: string): string {
  if (!text) {
    return text;
  }
  // Strip XML-wrapped thinking blocks
  let cleaned = text.replace(THINKING_BLOCK_RE, "").trim();
  // Strip leaked tool-call XML fragments
  cleaned = cleaned.replace(TOOL_CALL_LEAK_RE, "").trim();
  // Strip leading meta-commentary about the user's intent
  cleaned = cleaned.replace(THINKING_PREFIX_RE, "").trim();
  // Strip "Let me think about this..." preambles (up to first double newline)
  cleaned = cleaned.replace(LET_ME_THINK_RE, "").trim();
  return cleaned || text; // fallback to original if everything was stripped
}

/**
 * Fixes "flattened" markdown where the model outputs bold headings, bullet
 * points, and numbered lists on a single line with no line breaks.
 *
 * Example input:
 *   "recap: **today:** - item one - item two **yesterday:** - item three"
 * Output:
 *   "recap:\n\n**today:**\n- item one\n- item two\n\n**yesterday:**\n- item three"
 *
 * Only triggers when the text has very few newlines relative to its structural
 * marker density, to avoid breaking already-formatted text.
 */
export function fixFlattenedMarkdown(text: string): string {
  if (!text || text.length < 60) {
    return text;
  }
  const existingNewlines = (text.match(/\n/g) || []).length;
  // Count structural markers — match at start-of-string OR after a space/punctuation
  const boldHeaders = (text.match(/(?:^| )\*\*[^*]+(?::\*\*|\*\*:)/gm) || []).length;
  const dashBullets = (text.match(/(?:^| )- (?:\*\*|[A-Z0-9])/gm) || []).length;
  const asteriskBullets = (text.match(/(?:^| )\* (?:\*\*|[A-Z])/gm) || []).length;
  const numberedItems = (text.match(/(?:^| )\d+\. /gm) || []).length;
  const emojiHeaders = (
    text.match(/(?:^| )[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]+\s*\*\*/gmu) || []
  ).length;
  const structureCount = boldHeaders + dashBullets + asteriskBullets + numberedItems + emojiHeaders;

  // Trigger if text has structural markers but very few newlines
  if (structureCount >= 2 && existingNewlines <= structureCount * 0.5) {
    let fixed = text;
    // --- Step 1: compound list items (bullet/number + bold kept as one unit) ---
    // " - **Heading:** text" → "\n- **Heading:** text"
    fixed = fixed.replace(/ (- \*\*)/g, "\n$1");
    // " * **Heading:** text" → "\n* **Heading:** text"
    fixed = fixed.replace(/ (\* \*\*)/g, "\n$1");
    // " - Text" (dash bullet, plain uppercase) → "\n- Text"
    fixed = fixed.replace(/ (- [A-Z0-9])/g, "\n$1");
    // " * Text" (asterisk bullet, plain uppercase) → "\n* Text"
    fixed = fixed.replace(/ (\* [A-Z])/g, "\n$1");
    // " 1. **Bold" or " 1. Text" → "\n1. **Bold" (number + content stays together)
    fixed = fixed.replace(/ (\d+\.\s)/g, "\n$1");

    // --- Step 2: standalone bold section headers after sentence-ending punctuation ---
    // "sentence. **Heading:**" → "sentence.\n\n**Heading:**"
    // Exclude numbered list contexts: "1. **Bold" should NOT get a double newline
    fixed = fixed.replace(/([.!?)"]) (\*\*[^*]{2,}\*\*)/g, (_match, punct, header, offset) => {
      // Check if the period is from a numbered list (e.g., "1. ")
      const before = fixed.slice(Math.max(0, offset - 2), offset);
      if (/\d$/.test(before)) {
        return punct + " " + header; // keep as-is
      }
      return punct + "\n\n" + header;
    });
    // Emoji followed by bold (section header): " 📊 **Title**" → "\n\n📊 **Title**"
    fixed = fixed.replace(/ ([\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]+\s*\*\*)/gu, "\n\n$1");
    // Markdown headings: " ## " → "\n\n## "
    fixed = fixed.replace(/ (#{1,6} )/g, "\n\n$1");

    // --- Step 3: ensure spacing between sections ---
    // Blank line before numbered items that follow a bold header
    fixed = fixed.replace(/(\*\*)\n(\d+\.)/g, "$1\n\n$2");
    // Clean up excessive newlines (3+ → 2)
    fixed = fixed.replace(/\n{3,}/g, "\n\n");
    return fixed.trim();
  }

  // Fallback: long text (>250 chars) with zero newlines — insert paragraph breaks
  // between sentences to prevent wall-of-text output.
  if (existingNewlines === 0 && text.length > 250) {
    const sentences = text.split(/(?<=\.) (?=[A-Z])/);
    if (sentences.length >= 4) {
      // Group ~2-3 sentences per paragraph
      const paragraphs: string[] = [];
      let current: string[] = [];
      for (const sentence of sentences) {
        current.push(sentence);
        if (current.join(" ").length > 150) {
          paragraphs.push(current.join(" "));
          current = [];
        }
      }
      if (current.length > 0) {
        paragraphs.push(current.join(" "));
      }
      if (paragraphs.length >= 2) {
        return paragraphs.join("\n\n");
      }
    }
  }

  return text;
}

export type NormalizeReplySkipReason = "empty" | "silent" | "heartbeat";

export type NormalizeReplyOptions = {
  responsePrefix?: string;
  enableSlackInteractiveReplies?: boolean;
  /** Context for template variable interpolation in responsePrefix */
  responsePrefixContext?: ResponsePrefixContext;
  onHeartbeatStrip?: () => void;
  stripHeartbeat?: boolean;
  silentToken?: string;
  onSkip?: (reason: NormalizeReplySkipReason) => void;
};

export function normalizeReplyPayload(
  payload: ReplyPayload,
  opts: NormalizeReplyOptions = {},
): ReplyPayload | null {
  const hasContent = (text: string | undefined) =>
    hasReplyPayloadContent(
      {
        ...payload,
        text,
      },
      {
        trimText: true,
      },
    );
  const trimmed = payload.text?.trim() ?? "";
  if (!hasContent(trimmed)) {
    opts.onSkip?.("empty");
    return null;
  }

  const silentToken = opts.silentToken ?? SILENT_REPLY_TOKEN;
  let text = payload.text ?? undefined;
  if (text && isSilentReplyText(text, silentToken)) {
    if (!hasContent("")) {
      opts.onSkip?.("silent");
      return null;
    }
    text = "";
  }
  // Strip NO_REPLY from mixed-content messages (e.g. "😄 NO_REPLY") so the
  // token never leaks to end users.  If stripping leaves nothing, treat it as
  // silent just like the exact-match path above.  (#30916, #30955)
  if (text && text.includes(silentToken) && !isSilentReplyText(text, silentToken)) {
    text = stripSilentToken(text, silentToken);
    if (!hasContent(text)) {
      opts.onSkip?.("silent");
      return null;
    }
  }
  if (text && !trimmed) {
    // Keep empty text when media exists so media-only replies still send.
    text = "";
  }

  const shouldStripHeartbeat = opts.stripHeartbeat ?? true;
  if (shouldStripHeartbeat && text?.includes(HEARTBEAT_TOKEN)) {
    const stripped = stripHeartbeatToken(text, { mode: "message" });
    if (stripped.didStrip) {
      opts.onHeartbeatStrip?.();
    }
    if (stripped.shouldSkip && !hasContent(stripped.text)) {
      opts.onSkip?.("heartbeat");
      return null;
    }
    text = stripped.text;
  }

  if (text) {
    text = sanitizeUserFacingText(text, { errorContext: Boolean(payload.isError) });
    text = stripThinkingTextLeaks(text);
    text = fixFlattenedMarkdown(text);
  }
  if (!hasContent(text)) {
    opts.onSkip?.("empty");
    return null;
  }

  // Parse LINE-specific directives from text (quick_replies, location, confirm, buttons)
  let enrichedPayload: ReplyPayload = { ...payload, text };
  if (text && hasLineDirectives(text)) {
    enrichedPayload = parseLineDirectives(enrichedPayload);
    text = enrichedPayload.text;
  }

  // Resolve template variables in responsePrefix if context is provided
  const effectivePrefix = opts.responsePrefixContext
    ? resolveResponsePrefixTemplate(opts.responsePrefix, opts.responsePrefixContext)
    : opts.responsePrefix;

  if (
    effectivePrefix &&
    text &&
    text.trim() !== HEARTBEAT_TOKEN &&
    !text.startsWith(effectivePrefix)
  ) {
    text = `${effectivePrefix} ${text}`;
  }

  enrichedPayload = { ...enrichedPayload, text };
  if (opts.enableSlackInteractiveReplies && text && hasSlackDirectives(text)) {
    enrichedPayload = parseSlackDirectives(enrichedPayload);
  }

  return enrichedPayload;
}
