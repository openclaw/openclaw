import type { HumanMention } from "./chat-types.ts";
import { HUMAN_MENTION_CLIPBOARD_TYPE, readHumanMentions } from "./human-mentions.ts";

export type HumanMentionTransfer = { text: string; mentions: readonly HumanMention[] };

/** Untrusted transfer metadata; plain @Name text alone never creates a recipient. */
export function parseHumanMentionTransfer(
  text: string,
  raw: string,
): HumanMentionTransfer | undefined {
  if (!text || !raw) {
    return undefined;
  }
  try {
    const mentions = readHumanMentions(text, JSON.parse(raw));
    return mentions ? { text, mentions } : undefined;
  } catch {
    return undefined;
  }
}

export function readHumanMentionClipboard(
  data: DataTransfer | null,
): HumanMentionTransfer | undefined {
  // Files belong to the attachment owner; read no text for them.
  return data && !data.files.length
    ? parseHumanMentionTransfer(
        data.getData("text/plain"),
        data.getData(HUMAN_MENTION_CLIPBOARD_TYPE),
      )
    : undefined;
}

// The protocol requires a boundary around "@Name".
export const MENTION_BEFORE = /[\p{L}\p{N}\p{M}_@.%+-]$/u;
export const MENTION_AFTER = /^[\p{L}\p{N}\p{M}_-]/u;

/** Reserve protocol boundaries for incoming chips, not just existing chips. */
export function prepareHumanMentionPaste(
  value: string,
  start: number,
  end: number,
  copied: HumanMentionTransfer,
): HumanMentionTransfer {
  const prefix =
    copied.mentions[0]?.start === 0 && MENTION_BEFORE.test(value.slice(0, start)) ? " " : "";
  const suffix =
    copied.mentions.at(-1)?.end === copied.text.length && MENTION_AFTER.test(value.slice(end))
      ? " "
      : "";
  return {
    text: prefix + copied.text + suffix,
    mentions: copied.mentions.map((mention) => ({
      profileId: mention.profileId,
      start: mention.start + prefix.length,
      end: mention.end + prefix.length,
    })),
  };
}
