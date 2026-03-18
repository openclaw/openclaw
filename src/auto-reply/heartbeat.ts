import { escapeRegExp } from "../utils.js";
import { HEARTBEAT_TOKEN } from "./tokens.js";

// Default heartbeat prompt (used when config.agents.defaults.heartbeat.prompt is unset).
// Keep it tight and avoid encouraging the model to invent/rehash "open loops" from prior chat context.
export const HEARTBEAT_PROMPT =
  "Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK. Final output must be either exact HEARTBEAT_OK or a user-visible conclusion, never both.";
export const DEFAULT_HEARTBEAT_EVERY = "30m";
export const DEFAULT_HEARTBEAT_ACK_MAX_CHARS = 300;
export type HeartbeatReplyDisposition = "ack" | "deliver" | "malformedAck";

/**
 * Check if HEARTBEAT.md content is "effectively empty" - meaning it has no actionable tasks.
 * This allows skipping heartbeat API calls when no tasks are configured.
 *
 * A file is considered effectively empty if it contains only:
 * - Whitespace
 * - Comment lines (lines starting with #)
 * - Empty lines
 *
 * Note: A missing file returns false (not effectively empty) so the LLM can still
 * decide what to do. This function is only for when the file exists but has no content.
 */
export function isHeartbeatContentEffectivelyEmpty(content: string | undefined | null): boolean {
  if (content === undefined || content === null) {
    return false;
  }
  if (typeof content !== "string") {
    return false;
  }

  const lines = content.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    // Skip empty lines
    if (!trimmed) {
      continue;
    }
    // Skip markdown header lines (# followed by space or EOL, ## etc)
    // This intentionally does NOT skip lines like "#TODO" or "#hashtag" which might be content
    // (Those aren't valid markdown headers - ATX headers require space after #)
    if (/^#+(\s|$)/.test(trimmed)) {
      continue;
    }
    // Skip empty markdown list items like "- [ ]" or "* [ ]" or just "- "
    if (/^[-*+]\s*(\[[\sXx]?\]\s*)?$/.test(trimmed)) {
      continue;
    }
    // Found a non-empty, non-comment line - there's actionable content
    return false;
  }
  // All lines were either empty or comments
  return true;
}

export function resolveHeartbeatPrompt(raw?: string): string {
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  return trimmed || HEARTBEAT_PROMPT;
}

export type StripHeartbeatMode = "heartbeat" | "message";

function stripLeadingHeartbeatResponsePrefix(
  text: string,
  responsePrefix: string | undefined,
): string {
  const normalizedPrefix = responsePrefix?.trim();
  if (!normalizedPrefix) {
    return text;
  }

  // Require a boundary after the configured prefix so short prefixes like "Hi"
  // do not strip the beginning of normal words like "History".
  const prefixPattern = new RegExp(
    `^${escapeRegExp(normalizedPrefix)}(?=$|\\s|[\\p{P}\\p{S}])\\s*`,
    "iu",
  );
  return text.replace(prefixPattern, "");
}

function stripTokenAtEdges(raw: string): { text: string; didStrip: boolean } {
  let text = raw.trim();
  if (!text) {
    return { text: "", didStrip: false };
  }

  const token = HEARTBEAT_TOKEN;
  const tokenAtEndWithOptionalTrailingPunctuation = new RegExp(
    `${escapeRegExp(token)}[^\\w]{0,4}$`,
  );
  if (!text.includes(token)) {
    return { text, didStrip: false };
  }

  let didStrip = false;
  let changed = true;
  while (changed) {
    changed = false;
    const next = text.trim();
    if (next.startsWith(token)) {
      const after = next.slice(token.length).trimStart();
      text = after;
      didStrip = true;
      changed = true;
      continue;
    }
    // Strip the token when it appears at the end of the text.
    // Also strip up to 4 trailing non-word characters the model may have appended
    // (e.g. ".", "!!!", "---"). Keep trailing punctuation only when real
    // sentence text exists before the token.
    if (tokenAtEndWithOptionalTrailingPunctuation.test(next)) {
      const idx = next.lastIndexOf(token);
      const before = next.slice(0, idx).trimEnd();
      if (!before) {
        text = "";
      } else {
        const after = next.slice(idx + token.length).trimStart();
        text = `${before}${after}`.trimEnd();
      }
      didStrip = true;
      changed = true;
    }
  }

  const collapsed = text.replace(/\s+/g, " ").trim();
  return { text: collapsed, didStrip };
}

export function stripHeartbeatToken(
  raw?: string,
  opts: { mode?: StripHeartbeatMode; maxAckChars?: number } = {},
) {
  if (!raw) {
    return { shouldSkip: true, text: "", didStrip: false };
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return { shouldSkip: true, text: "", didStrip: false };
  }

  const mode: StripHeartbeatMode = opts.mode ?? "message";
  const maxAckCharsRaw = opts.maxAckChars;
  const parsedAckChars =
    typeof maxAckCharsRaw === "string" ? Number(maxAckCharsRaw) : maxAckCharsRaw;
  const maxAckChars = Math.max(
    0,
    typeof parsedAckChars === "number" && Number.isFinite(parsedAckChars)
      ? parsedAckChars
      : DEFAULT_HEARTBEAT_ACK_MAX_CHARS,
  );

  // Normalize lightweight markup so HEARTBEAT_OK wrapped in HTML/Markdown
  // (e.g., <b>HEARTBEAT_OK</b> or **HEARTBEAT_OK**) still strips.
  const stripMarkup = (text: string) =>
    text
      // Drop HTML tags.
      .replace(/<[^>]*>/g, " ")
      // Decode common nbsp variant.
      .replace(/&nbsp;/gi, " ")
      // Remove markdown-ish wrappers at the edges.
      .replace(/^[*`~_]+/, "")
      .replace(/[*`~_]+$/, "");

  const trimmedNormalized = stripMarkup(trimmed);
  const hasToken = trimmed.includes(HEARTBEAT_TOKEN) || trimmedNormalized.includes(HEARTBEAT_TOKEN);
  if (!hasToken) {
    return { shouldSkip: false, text: trimmed, didStrip: false };
  }

  const strippedOriginal = stripTokenAtEdges(trimmed);
  const strippedNormalized = stripTokenAtEdges(trimmedNormalized);
  const picked =
    strippedOriginal.didStrip && strippedOriginal.text ? strippedOriginal : strippedNormalized;
  if (!picked.didStrip) {
    return { shouldSkip: false, text: trimmed, didStrip: false };
  }

  if (!picked.text) {
    return { shouldSkip: true, text: "", didStrip: true };
  }

  const rest = picked.text.trim();
  if (mode === "heartbeat") {
    if (rest.length <= maxAckChars) {
      return { shouldSkip: true, text: "", didStrip: true };
    }
  }

  return { shouldSkip: false, text: rest, didStrip: true };
}

export function resolveHeartbeatReplyDisposition(params: {
  text?: string;
  responsePrefix?: string;
  hasMedia?: boolean;
  hasReasoning?: boolean;
  hasExecCompletion?: boolean;
  ackMaxChars?: number;
}): {
  disposition: HeartbeatReplyDisposition;
  text: string;
  hadToken: boolean;
} {
  const rawText = typeof params.text === "string" ? params.text : "";
  const textForStrip = stripLeadingHeartbeatResponsePrefix(rawText, params.responsePrefix);
  const stripped = stripHeartbeatToken(textForStrip, { mode: "message" });
  const heartbeatAckStrip =
    typeof params.ackMaxChars === "number"
      ? stripHeartbeatToken(textForStrip, {
          mode: "heartbeat",
          maxAckChars: params.ackMaxChars,
        })
      : null;
  const normalized = textForStrip.trim();
  const hasMedia = params.hasMedia === true;
  const hasReasoning = params.hasReasoning === true;
  const hasExecCompletion = params.hasExecCompletion === true;
  const normalizedMarkup = normalized
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/^[*`~_]+/, "")
    .replace(/[*`~_]+$/, "");
  const hadToken =
    normalized.includes(HEARTBEAT_TOKEN) || normalizedMarkup.includes(HEARTBEAT_TOKEN);
  const strippedRemainder = stripped.text.trim();
  const isSymbolOnlyRemainder =
    Boolean(strippedRemainder) && !/[\p{L}\p{N}]/u.test(strippedRemainder);

  if (!hadToken) {
    return {
      disposition: "deliver",
      text: rawText.trim(),
      hadToken: false,
    };
  }

  let finalText = stripped.didStrip ? stripped.text.trim() : rawText.trim();
  if (!finalText && hasExecCompletion) {
    finalText = rawText.trim();
  }
  if (params.responsePrefix && finalText && !finalText.startsWith(params.responsePrefix)) {
    finalText = `${params.responsePrefix} ${finalText}`;
  }

  if (hasExecCompletion) {
    return {
      disposition: "deliver",
      text: finalText,
      hadToken: true,
    };
  }

  if (
    !hasMedia &&
    !hasReasoning &&
    ((stripped.didStrip && (!strippedRemainder || isSymbolOnlyRemainder)) ||
      heartbeatAckStrip?.shouldSkip === true)
  ) {
    return {
      disposition: "ack",
      text: "",
      hadToken: true,
    };
  }

  return {
    disposition: "malformedAck",
    text: finalText,
    hadToken: true,
  };
}
