import { For, Show } from "solid-js";
import { sessionIconMask } from "../../../components/solid/icon.tsx";
import {
  getSlashCommandDescription,
  getSlashCommandTitle,
  type SlashCommandDef,
} from "../../../lib/chat/commands.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import { renderComposerMenuOption as ComposerMenuOption } from "./chat-composer-menu.tsx";
import { renderSlashMatchedName, SlashCommandTrail } from "./chat-composer-slash-menu-dom.tsx";
import {
  getSlashArgOptionId,
  getSlashCommandOptionId,
  type SlashMenu as SlashMenuState,
  type SlashMenuHost,
} from "./chat-composer-slash-menu-state.ts";
import type { SlashMenuCurrentValues } from "./chat-composer-slash-menu-values.ts";

export function SlashMenuOptions(props: {
  menu: SlashMenuState;
  host: SlashMenuHost;
  items: Array<{ command: SlashCommandDef; index: number }>;
  query: string;
  currentValues?: SlashMenuCurrentValues;
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
                1.6,
              ),
            }}
          />
        }
        name={
          <>
            {getSlashCommandTitle(childProps.command, t) ?? (
              <>/{renderSlashMatchedName(childProps.command.name, props.query)}</>
            )}
            {childProps.command.args ? (
              <span class="slash-menu-args"> {childProps.command.args}</span>
            ) : null}
          </>
        }
        description={getSlashCommandDescription(childProps.command).replace(/(?<!\.)\.$/u, "")}
        trailing={
          <SlashCommandTrail
            command={childProps.command}
            host={props.host}
            current={
              childProps.command.source !== "skill" && childProps.command.source !== "plugin"
                ? props.currentValues?.[childProps.command.key]
                : undefined
            }
          />
        }
      />
    );
  }

  return (
    <For each={props.items} keyed={(entry) => entry.command.name}>
      {(entry) => <CommandOption command={entry().command} index={entry().index} />}
    </For>
  );
}

export function SlashArgumentOptions(props: {
  menu: SlashMenuState;
  host: SlashMenuHost;
  currentValues?: SlashMenuCurrentValues;
}) {
  const state = () => props.menu.state;
  const current = () => props.currentValues?.[state().slashMenuCommand?.key ?? ""]?.value;
  return (
    <For each={state().slashMenuArgItems}>
      {(arg, index) => (
        <ComposerMenuOption
          id={getSlashArgOptionId(props.host.paneId, state().slashMenuCommand?.name ?? "", arg)}
          active={index() === state().slashMenuIndex}
          current={arg === current()}
          preserveFocus={false}
          select={() => props.menu.selectArg(arg, props.host)}
          hover={() => props.menu.hover(index())}
          icon={
            <Show when={arg === current()}>
              <i
                class="session-css-icon"
                aria-hidden="true"
                style={{ "mask-image": sessionIconMask("check", 1.6) }}
              />
            </Show>
          }
          name={arg}
        />
      )}
    </For>
  );
}
