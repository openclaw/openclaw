import { normalizeInteractiveReply, type InteractiveReply } from "../../interactive/payload.js";
import { splitMediaFromOutput } from "../../media/parse.js";
import { parseInlineDirectives } from "../../utils/directive-tags.js";
import { isSilentReplyPayloadText, SILENT_REPLY_TOKEN } from "../tokens.js";

export type ReplyDirectiveParseResult = {
  text: string;
  mediaUrls?: string[];
  mediaUrl?: string;
  replyToId?: string;
  replyToCurrent: boolean;
  replyToTag: boolean;
  audioAsVoice?: boolean;
  isSilent: boolean;
  interactive?: InteractiveReply;
};

// Matches [[buttons: [...]]] — captures the JSON array between [[buttons: and ]]
// The inner (\[[\s\S]*?\]) stops at the first ] after the opening [ of the JSON array,
// so the closing ]] of the tag is cleanly separated.
const BUTTONS_TAG_RE = /\[\[\s*buttons\s*:\s*(\[[\s\S]*?\])\s*\]\]/g;

function parseButtonsTagContent(json: string): InteractiveReply | undefined {
  try {
    const parsed: unknown = JSON.parse(json);
    return normalizeInteractiveReply({ blocks: [{ type: "buttons", buttons: parsed }] });
  } catch {
    return undefined;
  }
}

export function parseReplyDirectives(
  raw: string,
  options: { currentMessageId?: string; silentToken?: string } = {},
): ReplyDirectiveParseResult {
  const split = splitMediaFromOutput(raw);
  let text = split.text ?? "";

  const replyParsed = parseInlineDirectives(text, {
    currentMessageId: options.currentMessageId,
    stripAudioTag: false,
    stripReplyTags: true,
  });

  if (replyParsed.hasReplyTag) {
    text = replyParsed.text;
  }

  let interactive: InteractiveReply | undefined;

  if (text.includes("[[")) {
    BUTTONS_TAG_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = BUTTONS_TAG_RE.exec(text)) !== null) {
      const candidate = parseButtonsTagContent(match[1]);
      if (candidate) {
        interactive = candidate;
        break; // use the first valid [[buttons:...]] tag
      }
    }
    if (interactive) {
      // Strip all [[buttons: ...]] tags and normalize surrounding whitespace
      text = text.replace(/\s*\[\[\s*buttons\s*:\s*\[[\s\S]*?\]\s*\]\]\s*/g, " ").trim();
    }
  }

  const silentToken = options.silentToken ?? SILENT_REPLY_TOKEN;
  const isSilent = isSilentReplyPayloadText(text, silentToken);
  if (isSilent) {
    text = "";
  }

  return {
    text,
    mediaUrls: split.mediaUrls,
    mediaUrl: split.mediaUrl,
    replyToId: replyParsed.replyToId,
    replyToCurrent: replyParsed.replyToCurrent,
    replyToTag: replyParsed.hasReplyTag,
    audioAsVoice: split.audioAsVoice,
    isSilent,
    interactive,
  };
}
