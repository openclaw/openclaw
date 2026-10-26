import { For } from "solid-js";
import { Icon } from "../../../components/solid/icon.tsx";
import { getSlashCommandDescription, type SlashCommandDef } from "../../../lib/chat/commands.ts";
import { ComposerContent } from "./chat-composer-content.tsx";
import { renderComposerMenuOption as ComposerMenuOption } from "./chat-composer-menu.tsx";
import { renderSlashMatchedName } from "./chat-composer-slash-menu-dom.tsx";
import {
  getSlashArgOptionId,
  getSlashCommandOptionId,
  type SlashMenu as SlashMenuState,
  type SlashMenuHost,
} from "./chat-composer-slash-menu-state.ts";

function CommandOption(props: {
  menu: SlashMenuState;
  host: SlashMenuHost;
  command: SlashCommandDef;
  index: number;
  query: string;
}) {
  return (
    <ComposerMenuOption
      id={getSlashCommandOptionId(props.host.paneId, props.command)}
      active={props.index === props.menu.state.slashMenuIndex}
      select={() => props.menu.selectCommand(props.command, props.host)}
      hover={() => props.menu.hover(props.index)}
      icon={
        <ComposerContent>
          <Icon
            name={
              props.command.source === "skill"
                ? "pencilSparkles"
                : (props.command.icon ?? "terminal")
            }
          />
        </ComposerContent>
      }
      name={
        <>
          /{renderSlashMatchedName(props.command.name, props.query)}
          {props.command.args ? <span class="slash-menu-args"> {props.command.args}</span> : null}
        </>
      }
      description={getSlashCommandDescription(props.command)}
    />
  );
}

export function SlashMenuOptions(props: {
  menu: SlashMenuState;
  host: SlashMenuHost;
  items: Array<{ command: SlashCommandDef; index: number }>;
  query: string;
}) {
  return (
    <For each={props.items} keyed={(entry) => entry.command.name}>
      {(entry) => (
        <CommandOption
          menu={props.menu}
          host={props.host}
          command={entry().command}
          index={entry().index}
          query={props.query}
        />
      )}
    </For>
  );
}

export function SlashArgumentOptions(props: { menu: SlashMenuState; host: SlashMenuHost }) {
  const state = () => props.menu.state;
  return (
    <For each={state().slashMenuArgItems}>
      {(arg, index) => (
        <ComposerMenuOption
          id={getSlashArgOptionId(props.host.paneId, state().slashMenuCommand?.name ?? "", arg)}
          active={index() === state().slashMenuIndex}
          preserveFocus={false}
          select={() => props.menu.selectArg(arg, props.host)}
          hover={() => props.menu.hover(index())}
          icon={
            <ComposerContent>
              <Icon name={state().slashMenuCommand?.icon ?? "terminal"} />
            </ComposerContent>
          }
          name={arg}
          description={
            <>
              /{state().slashMenuCommand?.name} {arg}
            </>
          }
        />
      )}
    </For>
  );
}
