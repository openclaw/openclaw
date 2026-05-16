import {
  isSilentReplyText,
  SILENT_REPLY_TOKEN,
  startsWithSilentToken,
  stripLeadingSilentToken,
  stripSilentToken,
} from "../../auto-reply/tokens.js";

export type NormalizedSilentReplyText = {
  text: string | undefined;
  strippedTrailingSilentToken: boolean;
};

export function normalizeSilentReplyText(text: string | undefined): NormalizedSilentReplyText {
  if (!text) {
    return { text, strippedTrailingSilentToken: false };
  }
  if (isSilentReplyText(text, SILENT_REPLY_TOKEN)) {
    return { text: undefined, strippedTrailingSilentToken: false };
  }

  let next = text;
  const hasLeadingSilentToken = startsWithSilentToken(next, SILENT_REPLY_TOKEN);
  if (hasLeadingSilentToken) {
    next = stripLeadingSilentToken(next, SILENT_REPLY_TOKEN);
  }

  let strippedTrailingSilentToken = false;
  if (hasLeadingSilentToken || next.toLowerCase().includes(SILENT_REPLY_TOKEN.toLowerCase())) {
    const trimmedBefore = next.trim();
    const stripped = stripSilentToken(next, SILENT_REPLY_TOKEN);
    strippedTrailingSilentToken = stripped !== trimmedBefore;
    next = stripped;
  }

  if (!next.trim() || isSilentReplyText(next, SILENT_REPLY_TOKEN)) {
    return { text: undefined, strippedTrailingSilentToken };
  }
  return { text: next, strippedTrailingSilentToken };
}

export function isSilentForCronDelivery(text: string | undefined): boolean {
  const normalizedText = normalizeSilentReplyText(text);
  return normalizedText.text === undefined || normalizedText.strippedTrailingSilentToken;
}
