import { hasReplyPayloadContent } from "../../interactive/payload.js";
import {
  parseInlineDirectives,
  stripInlineDirectiveTagsForDelivery,
} from "../../utils/directive-tags.js";
import { isSilentReplyText, SILENT_REPLY_TOKEN } from "../tokens.js";
import { stripMixedSilentReplyTokens } from "./mixed-silent-reply-tokens.js";
import type { ReplyDirectiveParseResult } from "./reply-directives.js";

type ConsumeOptions = {
  final?: boolean;
};

export type StreamingDirectiveAccumulator = {
  readonly sourceText: string;
  consume(raw: string, options?: ConsumeOptions): ReplyDirectiveParseResult | null;
  reset(): void;
};

// TRANSITIONAL(marker-retirement): streaming tail-buffering exists only because
// live drafts still carry inline markers mid-run. Delete alongside the marker
// parser when the visibleReplies default flips to "message_tool".
// Hold incomplete tails until the inline parser can read complete reply/audio tags.
export const splitTrailingDirective = (
  text: string,
  options?: { preserveTrailingWhitespace?: boolean },
): { text: string; tail: string } => {
  let bufferStart = text.length;
  let trimTextBeforeTail = false;

  // Unclosed `[[…` reply/audio directive tail.
  const openIndex = text.lastIndexOf("[[");
  if (openIndex >= 0 && !text.includes("]]", openIndex + 2)) {
    bufferStart = openIndex;
    trimTextBeforeTail = true;
  }
  if (text.endsWith("[") && text.length - 1 < bufferStart) {
    bufferStart = text.length - 1;
    trimTextBeforeTail = true;
  }

  // Keep a possible final-reply MEDIA directive out of partial streaming
  // payloads. The final message parser still owns legacy MEDIA delivery.
  const mediaLineStart = text.lastIndexOf("\n") + 1;
  const lastLine = text.slice(mediaLineStart);
  if (/^\s*MEDIA:/i.test(lastLine) || /^[\t ]*(MEDIA|MEDI|MED|ME|M)$/i.test(lastLine)) {
    bufferStart = Math.min(bufferStart, mediaLineStart);
  }

  if (bufferStart >= text.length) {
    return { text, tail: "" };
  }

  const head = text.slice(0, bufferStart);
  return {
    text: trimTextBeforeTail && !options?.preserveTrailingWhitespace ? head.trimEnd() : head,
    tail: text.slice(bufferStart),
  };
};

export function createStreamingDirectiveAccumulator(): StreamingDirectiveAccumulator {
  let pendingTail = "";
  let pendingSeparator = "";
  let replyToId: string | undefined;
  let replyToCurrent = false;
  let replyToTag = false;
  let hasReturnedText = false;
  let pendingProtocol = "";
  let protocolResolved = false;
  let sourceText = "";

  const reset = () => {
    pendingTail = "";
    pendingSeparator = "";
    replyToId = undefined;
    replyToCurrent = false;
    replyToTag = false;
    hasReturnedText = false;
    pendingProtocol = "";
    protocolResolved = false;
    sourceText = "";
  };

  const consume = (raw: string, options?: ConsumeOptions): ReplyDirectiveParseResult | null => {
    let prepared = raw ?? "";
    if (!protocolResolved) {
      pendingProtocol += prepared;
      const stripped = stripMixedSilentReplyTokens(pendingProtocol);
      if (stripped !== null) {
        prepared = stripped;
        protocolResolved = true;
      } else if (options?.final) {
        if (isSilentReplyText(pendingProtocol)) {
          pendingProtocol = "";
          protocolResolved = true;
          return null;
        }
        prepared = pendingProtocol;
        protocolResolved = true;
      } else {
        const candidate = pendingProtocol.trimStart();
        if (
          !candidate ||
          SILENT_REPLY_TOKEN.startsWith(candidate) ||
          isSilentReplyText(candidate)
        ) {
          return null;
        }
        prepared = pendingProtocol;
        protocolResolved = true;
      }
      pendingProtocol = "";
    }
    sourceText += prepared;
    const hadPendingTail = pendingTail.length > 0;
    const heldSeparator = pendingSeparator;
    let combined = `${pendingTail}${prepared}`;
    pendingTail = "";
    pendingSeparator = "";

    if (!options?.final) {
      const split = splitTrailingDirective(combined);
      if (split.tail) {
        const tailStart = combined.length - split.tail.length;
        const separator = combined.slice(split.text.length, tailStart);
        // The separator is not part of a possible directive. Hold it separately
        // so valid completions keep existing streaming behavior while a final
        // malformed tail can be restored verbatim.
        pendingSeparator = split.text ? separator : `${heldSeparator}${separator}`;
      }
      combined = split.text;
      pendingTail = split.tail;
    }

    if (!combined) {
      return null;
    }

    const parsed = combined.includes("[[") ? parseInlineDirectives(combined) : undefined;
    let text = parsed && (parsed.hasReplyTag || parsed.hasAudioTag) ? parsed.text : combined;
    if (hadPendingTail && heldSeparator && text.startsWith("[")) {
      text = heldSeparator + text;
    }
    // Only a message-leading malformed marker is delivery control. Once text has
    // streamed, a later marker is literal content whose Markdown opener may be gone.
    if (options?.final && !hasReturnedText) {
      text = stripInlineDirectiveTagsForDelivery(text).text;
    }
    // Reply context survives directive-only and visible chunks until the assistant message resets.
    replyToId = parsed?.replyToExplicitId ?? replyToId;
    replyToCurrent ||= parsed?.replyToCurrent === true;
    replyToTag ||= parsed?.hasReplyTag === true;

    const combinedResult = {
      text,
      replyToId,
      replyToExplicitId: parsed?.replyToExplicitId,
      replyToCurrent,
      replyToTag,
      audioAsVoice: parsed?.audioAsVoice ?? false,
    };

    if (!hasReplyPayloadContent(combinedResult) && !combinedResult.audioAsVoice) {
      return null;
    }

    hasReturnedText ||= Boolean(combinedResult.text);
    return combinedResult;
  };

  return {
    get sourceText() {
      return sourceText;
    },
    consume,
    reset,
  };
}
