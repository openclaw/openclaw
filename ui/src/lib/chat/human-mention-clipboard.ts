import type { HumanMention } from "./chat-types.ts";
import { readHumanMentions } from "./human-mentions.ts";

export const HUMAN_MENTION_CLIPBOARD_TYPE = "application/x-openclaw-mentions";

/** Plain @Name text alone never creates a recipient. */
export function readHumanMentionClipboard(
  data: DataTransfer | null,
): { text: string; mentions: readonly HumanMention[] } | undefined {
  const text = data?.getData("text/plain");
  const raw = data?.getData(HUMAN_MENTION_CLIPBOARD_TYPE);
  if (!text || !raw || data?.files.length) {
    return undefined;
  }
  try {
    const mentions = readHumanMentions(text, JSON.parse(raw));
    return mentions ? { text, mentions } : undefined;
  } catch {
    return undefined;
  }
}

/** Reserve protocol boundaries for incoming chips, not just existing chips. */
export function prepareHumanMentionPaste(
  value: string,
  start: number,
  end: number,
  copied: { text: string; mentions: readonly HumanMention[] },
) {
  const prefix =
    copied.mentions[0]?.start === 0 && /[\p{L}\p{N}\p{M}_@.%+-]$/u.test(value.slice(0, start))
      ? " "
      : "";
  const suffix =
    copied.mentions.at(-1)?.end === copied.text.length &&
    /^[\p{L}\p{N}\p{M}_-]/u.test(value.slice(end))
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
