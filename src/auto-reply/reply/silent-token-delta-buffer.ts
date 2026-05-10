import {
  couldBeSilentTokenStart,
  isSilentReplyPrefixText,
  isSilentReplyText,
  SILENT_REPLY_TOKEN,
} from "../tokens.js";

export function createSilentTokenDeltaBuffer(token: string = SILENT_REPLY_TOKEN) {
  let prefix = "";

  return {
    consume(text: string | undefined): { text?: string; skip: boolean } {
      // Merge BPE splits like "NO" + "_REPLY" before deciding whether to suppress.
      const combined = `${prefix}${text ?? ""}`;
      prefix = "";
      if (isSilentReplyText(combined, token)) {
        return { skip: true };
      }
      if (couldBeSilentTokenStart(combined, token)) {
        prefix = combined;
        return { skip: true };
      }
      if (isSilentReplyPrefixText(combined, token)) {
        return { skip: true };
      }
      return { text: combined, skip: false };
    },
  };
}
