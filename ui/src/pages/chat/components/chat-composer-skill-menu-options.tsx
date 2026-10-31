import { For } from "solid-js";
import { Icon } from "../../../components/solid/icon.tsx";
import { getSkillDisplayName, getSlashCommandDescription } from "../../../lib/chat/commands.ts";
import { ComposerContent } from "./chat-composer-content.tsx";
import { renderComposerMenuOption as ComposerMenuOption } from "./chat-composer-menu.tsx";
import {
  skillOptionId,
  type SkillMenu as SkillMenuState,
  type SkillMenuHost,
} from "./chat-composer-skill-menu-state.ts";
import { renderSlashMatchedName } from "./chat-composer-slash-menu-dom.tsx";

export function SkillMenuOptions(props: { menu: SkillMenuState; host: SkillMenuHost }) {
  const state = () => props.menu.state;
  return (
    <For each={state().skillMenuItems}>
      {(command, index) => (
        <ComposerMenuOption
          id={skillOptionId(props.host.paneId, command)}
          active={index() === state().skillMenuIndex}
          select={() => props.menu.select(command, props.host)}
          hover={() => props.menu.hover(index())}
          icon={
            <ComposerContent>
              <Icon name="pencilSparkles" />
            </ComposerContent>
          }
          name={renderSlashMatchedName(
            getSkillDisplayName(command),
            state().skillMenuTarget?.query ?? "",
          )}
          description={getSlashCommandDescription(command)}
        />
      )}
    </For>
  );
}
