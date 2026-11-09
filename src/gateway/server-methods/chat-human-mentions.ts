import type { Result } from "@openclaw/normalization-core/result";
import { containsAsciiControlCharacter } from "@openclaw/normalization-core/string-normalization";
import type { HumanMention } from "../../../packages/gateway-protocol/src/index.js";
import { buildMentionRegexes, matchesMentionPatterns } from "../../auto-reply/reply/mentions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { sanitizeChatSendMessageInput } from "../chat-input-sanitize.js";

const INVALID_MENTIONS = "Selected mentions no longer match the message. Select the people again.";

function splitsSurrogate(text: string, offset: number): boolean {
  const before = text.charCodeAt(offset - 1);
  const after = text.charCodeAt(offset);
  return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff;
}

/**
 * A message that selects people and never names the agent is addressed to those
 * people. The agent's group-chat mention patterns (identity name, emoji, or
 * configured `mentionPatterns`) decide whether it was named; the selected
 * tokens are excluded so a person whose handle contains the agent's name does
 * not address it.
 */
export function isHumanAddressedChatMessage(params: {
  cfg: OpenClawConfig;
  agentId: string;
  text: string;
  mentions: readonly HumanMention[] | undefined;
}): boolean {
  if (!params.mentions?.length) {
    return false;
  }
  let remaining = "";
  let cursor = 0;
  for (const mention of params.mentions) {
    remaining += params.text.slice(cursor, mention.start);
    cursor = mention.end;
  }
  remaining += params.text.slice(cursor);
  return !matchesMentionPatterns(remaining, buildMentionRegexes(params.cfg, params.agentId));
}

/** Normalize raw selected spans against the request boundary's sanitized message. */
export function normalizeChatHumanMentions(
  text: string,
  mentions: readonly HumanMention[] | undefined,
  sanitizedText: string,
): Result<HumanMention[] | undefined, string> {
  if (!mentions?.length) {
    return { ok: true, value: undefined };
  }
  const leadingSpace = sanitizedText.length - sanitizedText.trimStart().length;
  const trimmed = sanitizedText.trim();
  const normalized: HumanMention[] = [];
  let previousEnd = 0;
  for (const mention of mentions) {
    const token = text.slice(mention.start, mention.end);
    if (
      mention.start < previousEnd ||
      mention.end > text.length ||
      mention.end <= mention.start + 1 ||
      token.length > 257 ||
      token[0] !== "@" ||
      !token.slice(1).trim() ||
      containsAsciiControlCharacter(token) ||
      splitsSurrogate(text, mention.start) ||
      splitsSurrogate(text, mention.end)
    ) {
      return { ok: false, error: INVALID_MENTIONS };
    }
    const prefix = sanitizeChatSendMessageInput(text.slice(0, mention.start));
    const throughToken = sanitizeChatSendMessageInput(text.slice(0, mention.end));
    if (!prefix.ok || !throughToken.ok || !sanitizedText.startsWith(throughToken.message)) {
      // A boundary inside a combining sequence cannot survive NFC as the selected token.
      return { ok: false, error: INVALID_MENTIONS };
    }
    const start = prefix.message.length - leadingSpace;
    const end = throughToken.message.length - leadingSpace;
    if (start < 0 || end > trimmed.length || trimmed[start] !== "@") {
      return { ok: false, error: INVALID_MENTIONS };
    }
    normalized.push({ profileId: mention.profileId, start, end });
    previousEnd = mention.end;
  }
  return { ok: true, value: normalized };
}
