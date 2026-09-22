import type { SlashCommandDef } from "../../../lib/chat/commands.ts";
import { resolveThinkingCommandArgOptionsForSession } from "../../../lib/chat/thinking.ts";
import { paneDomId } from "./chat-composer-dom.ts";
import type { ComposerEmojiMenu } from "./chat-composer-emoji.ts";
import type { HumanMentionMenu } from "./chat-composer-mention-menu.ts";
import {
  getActiveSkillMenuOptionId,
  getActiveSkillMenuOptionLabel,
  isSkillMenuVisible,
  type SkillMenuState,
} from "./chat-composer-skill-menu.ts";
import {
  getActiveSlashMenuOptionId,
  getActiveSlashMenuOptionLabel,
  isSlashMenuVisible,
  type SlashMenuState,
} from "./chat-composer-slash-menu.ts";
import type { ChatComposerProps } from "./chat-composer-types.ts";

export function resolveChatSlashCommandArgOptions(
  command: SlashCommandDef,
  props: ChatComposerProps,
): string[] {
  if (command.key !== "think") {
    return command.argOptions ?? [];
  }
  if (props.modelSwitching) {
    return [];
  }
  return resolveThinkingCommandArgOptionsForSession(
    props.selectedSession,
    props.sessions?.defaults,
    props.modelCatalog,
  );
}

/** Hosts own admission; both editors expose the same active suggestion to assistive technology. */
export function resolveComposerMenus(
  paneId: string,
  commandsVisible: boolean,
  skill: SkillMenuState,
  slash: SlashMenuState,
  mention: HumanMentionMenu,
  emoji: ComposerEmojiMenu,
) {
  const skillMenuVisible = commandsVisible && isSkillMenuVisible(skill);
  const slashMenuVisible = commandsVisible && isSlashMenuVisible(slash);
  return {
    skillMenuVisible,
    slashMenuVisible,
    mentionMenuVisible: mention.open,
    emojiMenuVisible: emoji.open,
    menuVisible: skillMenuVisible || slashMenuVisible || mention.open || emoji.open,
    activeMenuOptionId: emoji.open
      ? emoji.activeId(paneId)
      : mention.open
        ? mention.activeId(paneId)
        : skillMenuVisible
          ? getActiveSkillMenuOptionId(skill, paneId)
          : getActiveSlashMenuOptionId(slash, paneId),
    activeMenuOptionLabel: emoji.open
      ? emoji.activeLabel()
      : mention.open
        ? mention.activeLabel()
        : skillMenuVisible
          ? getActiveSkillMenuOptionLabel(skill)
          : getActiveSlashMenuOptionLabel(slash),
    menuListboxId: paneDomId(
      paneId,
      emoji.open
        ? "emoji-menu-listbox"
        : mention.open
          ? "mention-menu-listbox"
          : skillMenuVisible
            ? "skill-menu-listbox"
            : "slash-menu-listbox",
    ),
  };
}
