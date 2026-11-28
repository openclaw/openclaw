import type { ApplicationContext } from "../../../app/context-types.ts";
import type { HumanMention } from "../../../lib/chat/chat-types.ts";
import { readHumanMentions } from "../../../lib/chat/human-mentions.ts";
import { readComposerSkillReferences } from "../../../lib/chat/skill-references.ts";
import {
  mountMentionComposerEditor,
  type ComposerMentionSnapshot,
} from "./composer-editor-mentions.tsx";
import { composerSkillExtension } from "./composer-editor-skills.ts";

/** The lazy integration boundary composes features through native CM extensions.
 * Recipient identity remains mention-owned; skills derive from canonical text. */
export function mountReferenceComposerEditor(
  input: HTMLTextAreaElement,
  mentions: () => readonly HumanMention[],
  application?: ApplicationContext,
  nativeHistory?: ComposerMentionSnapshot,
  avatarUrls?: ReadonlyMap<string, string>,
  forTransfer = false,
  editingValue?: string,
  previousInput?: ComposerMentionSnapshot,
) {
  const people = readHumanMentions(input.value, mentions()) ?? [];
  const editingAt = editingValue === input.value ? input.selectionStart : undefined;
  if (
    !forTransfer &&
    !people.length &&
    !readComposerSkillReferences(input.value, editingAt).length
  ) {
    return undefined;
  }
  return mountMentionComposerEditor(
    input,
    mentions,
    application,
    forTransfer
      ? undefined
      : nativeHistory?.value === input.value && !people.length
        ? previousInput
        : nativeHistory,
    avatarUrls,
    composerSkillExtension(input),
  );
}
