import type { HumanMention } from "../../../lib/chat/chat-types.ts";
import { readHumanMentions, updateHumanMentions } from "../../../lib/chat/human-mentions.ts";

/** Preview the existing recipient spans without changing their authoritative owner. */
export function resolveComposerMentionHighlights(
  value: string,
  draft: string,
  mentions: readonly HumanMention[],
) {
  return (
    readHumanMentions(
      value,
      value === draft ? mentions : updateHumanMentions(draft, value, mentions),
    ) ?? []
  );
}
