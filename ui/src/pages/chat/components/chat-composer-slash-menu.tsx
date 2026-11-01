import { For, Show, createMemo, lazy } from "solid-js";
import {
  getSlashCommandCategoryLabel,
  getSlashCommandDescription,
  type SlashCommandCategory,
  type SlashCommandDef,
} from "../../../lib/chat/commands.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import { paneDomId } from "./chat-composer-dom.ts";
import { ComposerMenu, ComposerMenuLoadingRows } from "./chat-composer-menu.tsx";
import {
  getActiveSlashMenuOptionId,
  getSlashArgOptionId,
  getSlashCommandOptionId,
  isSlashMenuVisible,
  type SlashMenu as SlashMenuState,
  type SlashMenuHost,
} from "./chat-composer-slash-menu-state.ts";
import { ChatLazyBoundary } from "./chat-lazy-boundary.tsx";

const SlashMenuOptions = lazy(() => import("./chat-composer-slash-menu-options.tsx"), {
  export: "SlashMenuOptions",
});
const SlashArgumentOptions = lazy(() => import("./chat-composer-slash-menu-options.tsx"), {
  export: "SlashArgumentOptions",
});

export function SlashMenu(props: { menu: SlashMenuState; host: SlashMenuHost; draft: string }) {
  const state = () => props.menu.state;
  const mode = () =>
    isSlashMenuVisible(state()) ? (state().slashMenuMode === "args" ? "args" : "command") : null;
  const grouped = createMemo(() => {
    const groups: Array<
      [SlashCommandCategory | "skills", Array<{ command: SlashCommandDef; index: number }>]
    > = [];
    for (const [index, command] of state().slashMenuItems.entries()) {
      const category = command.source === "skill" ? "skills" : (command.category ?? "session");
      const group = props.draft === "/" ? groups.find(([key]) => key === category) : groups.at(-1);
      if (group?.[0] === category) {
        group[1].push({ command, index });
      } else {
        groups.push([category, [{ command, index }]]);
      }
    }
    return groups;
  });
  return (
    <Show when={mode()} keyed>
      {(activeMode) => (
        <ComposerMenu
          getTextarea={() => props.host.getTextarea()}
          id={paneDomId(props.host.paneId, "slash-menu-listbox")}
          label={t(activeMode === "args" ? "chat.commands.arguments" : "chat.commands.menu")}
          activeId={getActiveSlashMenuOptionId(state(), props.host.paneId)}
          revision={activeMode === "args" ? state().slashMenuArgItems : state().slashMenuItems}
        >
          {activeMode === "args" ? (
            <div class="slash-menu-group">
              <div class="slash-menu-group__label">
                /{state().slashMenuCommand?.name}{" "}
                {state().slashMenuCommand
                  ? getSlashCommandDescription(state().slashMenuCommand!)
                  : ""}
              </div>
              <ChatLazyBoundary
                fallback={
                  <ComposerMenuLoadingRows
                    activeId={getActiveSlashMenuOptionId(state(), props.host.paneId)}
                    preserveFocus={false}
                    rows={state().slashMenuArgItems.map((arg, index) => ({
                      id: getSlashArgOptionId(
                        props.host.paneId,
                        state().slashMenuCommand?.name ?? "",
                        arg,
                      ),
                      name: arg,
                      description: `/${state().slashMenuCommand?.name} ${arg}`,
                      select: () => props.menu.selectArg(arg, props.host),
                      hover: () => props.menu.hover(index),
                    }))}
                  />
                }
                onClose={() => props.menu.reset()}
              >
                <SlashArgumentOptions menu={props.menu} host={props.host} />
              </ChatLazyBoundary>
            </div>
          ) : (
            <For each={grouped()} keyed={false}>
              {(group) => {
                const label = createMemo(() => {
                  const category = group()[0];
                  return category === "skills"
                    ? t("chat.skills.label")
                    : getSlashCommandCategoryLabel(category);
                });
                return (
                  <div
                    class={[
                      "slash-menu-group",
                      { "slash-menu-group--skills": group()[0] === "skills" },
                    ]}
                  >
                    <div class="slash-menu-group__label">{label()}</div>
                    <ChatLazyBoundary
                      fallback={
                        <ComposerMenuLoadingRows
                          activeId={getActiveSlashMenuOptionId(state(), props.host.paneId)}
                          rows={group()[1].map(({ command, index }) => ({
                            id: getSlashCommandOptionId(props.host.paneId, command),
                            name: `/${command.name}${command.args ? ` ${command.args}` : ""}`,
                            description: getSlashCommandDescription(command),
                            select: () => props.menu.selectCommand(command, props.host),
                            hover: () => props.menu.hover(index),
                          }))}
                        />
                      }
                      onClose={() => props.menu.reset()}
                    >
                      <SlashMenuOptions
                        menu={props.menu}
                        host={props.host}
                        items={group()[1]}
                        query={props.draft.slice(1)}
                      />
                    </ChatLazyBoundary>
                  </div>
                );
              }}
            </For>
          )}
        </ComposerMenu>
      )}
    </Show>
  );
}
