import { For } from "solid-js";
import { sessionIconMask } from "../../../components/solid/icon.tsx";
import { getSlashCommandDescription, type SlashCommandDef } from "../../../lib/chat/commands.ts";
import { renderComposerMenuOption as ComposerMenuOption } from "./chat-composer-menu.tsx";
import { renderSlashMatchedName } from "./chat-composer-slash-menu-dom.tsx";
import {
  getSlashArgOptionId,
  getSlashCommandOptionId,
  type SlashMenu as SlashMenuState,
  type SlashMenuHost,
} from "./chat-composer-slash-menu-state.ts";

export function SlashMenuOptions(props: {
  menu: SlashMenuState;
  host: SlashMenuHost;
  items: Array<{ command: SlashCommandDef; index: number }>;
  query: string;
}) {
  function CommandOption(childProps: { command: SlashCommandDef; index: number }) {
    return (
      <ComposerMenuOption
        id={getSlashCommandOptionId(props.host.paneId, childProps.command)}
        active={childProps.index === props.menu.state.slashMenuIndex}
        select={() => props.menu.selectCommand(childProps.command, props.host)}
        hover={() => props.menu.hover(childProps.index)}
        icon={
          <i
            class="session-css-icon"
            aria-hidden="true"
            style={{
              "mask-image": sessionIconMask(
                childProps.command.source === "skill"
                  ? "pencilSparkles"
                  : (childProps.command.icon ?? "terminal"),
                1.5,
              ),
            }}
          />
        }
        name={
          <>
            /{renderSlashMatchedName(childProps.command.name, props.query)}
            {childProps.command.args ? (
              <span class="slash-menu-args"> {childProps.command.args}</span>
            ) : null}
          </>
        }
        description={getSlashCommandDescription(childProps.command)}
      />
    );
  }

  return (
    <For each={props.items} keyed={(entry) => entry.command.name}>
      {(entry) => <CommandOption command={entry().command} index={entry().index} />}
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
            <i
              class="session-css-icon"
              aria-hidden="true"
              style={{
                "mask-image": sessionIconMask(state().slashMenuCommand?.icon ?? "terminal", 1.5),
              }}
            />
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
