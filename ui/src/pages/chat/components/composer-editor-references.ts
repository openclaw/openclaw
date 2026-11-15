import type { ApplicationContext } from "../../../app/context-types.ts";
import type { HumanMention } from "../../../lib/chat/chat-types.ts";
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
) {
  return mountMentionComposerEditor(
    input,
    mentions,
    application,
    nativeHistory,
    avatarUrls,
    composerSkillExtension(input),
  );
}
