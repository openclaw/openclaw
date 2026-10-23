import { For, Show, createMemo, createStore } from "solid-js";
import type { ChatSendShortcut } from "../../../app/settings.ts";
import { Icon } from "../../../components/solid/icon.tsx";
import {
  SLASH_COMMANDS,
  executesInlineImmediately,
  findInlineSlashCompletion,
  getSlashCommandCategoryLabel,
  getSlashCommandCompletions,
  getSlashCommandDescription,
  type InlineSlashCompletion,
  type SlashCommandCategory,
  type SlashCommandDef,
} from "../../../lib/chat/commands.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import { ComposerContent } from "./chat-composer-content.tsx";
import { paneDomId } from "./chat-composer-dom.ts";
import {
  beginInlineFreeformSlashArguments,
  commitInlineSlashSelection,
  findDirectInlineSlashArgumentInvocation,
  hasActiveInlineSlashArgumentPrefix,
  removeInlineSlashSelection,
} from "./chat-composer-inline-slash.ts";
import {
  handleComposerMenuKeydown,
  ComposerMenu,
  renderComposerMenuOption as ComposerMenuOption,
} from "./chat-composer-menu.tsx";
import type { SkillMenuHost } from "./chat-composer-skill-menu.tsx";
import {
  getSlashArgOptionId,
  getSlashCommandOptionId,
  getSlashCommandOptionLabel,
  renderSlashMatchedName,
} from "./chat-composer-slash-menu-dom.tsx";

export type SlashMenuState = {
  slashMenuOpen: boolean;
  slashMenuItems: SlashCommandDef[];
  slashMenuIndex: number;
  slashMenuMode: "command" | "args" | "freeform-args";
  slashMenuCommand: SlashCommandDef | null;
  slashMenuArgItems: string[];
  slashMenuCompletion: InlineSlashCompletion | null;
};

export type SlashMenuHost = SkillMenuHost & {
  resolveArgOptions: (command: SlashCommandDef) => string[];
  runCommand: () => void;
  canRun: (inline: boolean, command?: SlashCommandDef, args?: string) => boolean;
  runInlineCommand?: (command: string) => void;
  commandFilter?: (command: SlashCommandDef) => boolean;
  activateComposerMode?: (command: SlashCommandDef, inline: boolean) => boolean;
};

export function isSlashMenuVisible(state: SlashMenuState): boolean {
  return (
    state.slashMenuOpen &&
    (state.slashMenuMode === "args"
      ? Boolean(state.slashMenuCommand && state.slashMenuArgItems.length > 0)
      : state.slashMenuItems.length > 0)
  );
}

export function getActiveSlashMenuOptionId(state: SlashMenuState, paneId: string): string | null {
  if (!isSlashMenuVisible(state)) {
    return null;
  }
  if (state.slashMenuMode === "args") {
    const commandName = state.slashMenuCommand?.name;
    const arg = state.slashMenuArgItems[state.slashMenuIndex];
    return commandName && arg ? getSlashArgOptionId(paneId, commandName, arg) : null;
  }
  const cmd = state.slashMenuItems[state.slashMenuIndex];
  return cmd ? getSlashCommandOptionId(paneId, cmd) : null;
}

export function getActiveSlashMenuOptionLabel(state: SlashMenuState): string {
  if (!isSlashMenuVisible(state)) {
    return "";
  }
  if (state.slashMenuMode === "args") {
    const commandName = state.slashMenuCommand?.name;
    const arg = state.slashMenuArgItems[state.slashMenuIndex];
    return commandName && arg ? `/${commandName} ${arg}` : "";
  }
  return getSlashCommandOptionLabel(state.slashMenuItems[state.slashMenuIndex]);
}

export function createSlashMenu() {
  let refreshPending = false;
  let refreshGeneration = 0;
  const [presentation, setState] = createStore<SlashMenuState>({
    slashMenuOpen: false,
    slashMenuItems: [],
    slashMenuIndex: 0,
    slashMenuMode: "command",
    slashMenuCommand: null,
    slashMenuArgItems: [],
    slashMenuCompletion: null,
  });

  function resetSlashMenuState(state: SlashMenuState): void {
    state.slashMenuOpen = false;
    state.slashMenuMode = "command";
    state.slashMenuCommand = null;
    state.slashMenuArgItems = [];
    state.slashMenuItems = [];
    state.slashMenuCompletion = null;
  }

  function closeSlashMenuIfNeeded(state: SlashMenuState): void {
    if (
      state.slashMenuOpen ||
      state.slashMenuMode !== "command" ||
      state.slashMenuCommand !== null ||
      state.slashMenuArgItems.length > 0 ||
      state.slashMenuItems.length > 0
    ) {
      resetSlashMenuState(state);
    }
  }

  function openSlashArgumentMenu(state: SlashMenuState, command: SlashCommandDef, args: string[]) {
    state.slashMenuMode = "args";
    state.slashMenuCommand = command;
    state.slashMenuArgItems = args;
    state.slashMenuOpen = true;
    state.slashMenuIndex = 0;
    state.slashMenuItems = [];
  }

  function requestSlashCommandRefresh(host: SlashMenuHost): void {
    if (!host.refreshCommands || refreshPending) {
      return;
    }
    const refresh = host.refreshCommands();
    if (!refresh) {
      return;
    }
    refreshPending = true;
    const generation = refreshGeneration;
    void refresh
      .catch(() => undefined)
      .finally(() => {
        if (generation !== refreshGeneration) {
          return;
        }
        refreshPending = false;
        setState((draft) => {
          // Dismissal retires completion intent; a late refresh must not reopen it.
          if (
            (!draft.slashMenuOpen && !draft.slashMenuCompletion) ||
            (draft.slashMenuMode === "args" && draft.slashMenuCompletion?.inline)
          ) {
            return;
          }
          // Parse the argument draft as well as its command token after refresh.
          updateSlashMenu(host.getDraft(), draft, host, { skipSlashIntent: true });
        });
      });
  }

  function updateSlashMenu(
    value: string,
    state: SlashMenuState,
    host: SlashMenuHost,
    opts: { skipSlashIntent?: boolean } = {},
  ): void {
    if (
      state.slashMenuMode === "freeform-args" &&
      state.slashMenuCompletion?.inline &&
      state.slashMenuCommand
    ) {
      const caret = host.getTextarea()?.selectionStart ?? value.length;
      const completion = state.slashMenuCompletion;
      if (
        hasActiveInlineSlashArgumentPrefix(value, caret, completion, state.slashMenuCommand.name)
      ) {
        state.slashMenuCompletion.end = caret;
        return;
      }
      resetSlashMenuState(state);
    }

    const argMatch = value.match(/^\/(\S+)\s(.*)$/);
    if (argMatch) {
      if (!opts.skipSlashIntent) {
        requestSlashCommandRefresh(host);
      }
      const cmdName = argMatch[1]!.toLowerCase();
      const argFilter = argMatch[2]!.toLowerCase();
      const cmd = SLASH_COMMANDS.find(
        (entry) => entry.name === cmdName && (host.commandFilter?.(entry) ?? true),
      );
      const argOptions = cmd ? host.resolveArgOptions(cmd) : [];
      if (cmd && argOptions.length > 0) {
        const filtered = argFilter
          ? argOptions.filter((arg) => arg.toLowerCase().startsWith(argFilter))
          : argOptions;
        if (filtered.length > 0) {
          openSlashArgumentMenu(state, cmd, filtered);
          state.slashMenuCompletion = null;
          return;
        }
      }
      closeSlashMenuIfNeeded(state);
      return;
    }

    const caret = host.getTextarea()?.selectionStart ?? value.length;
    const completion = findInlineSlashCompletion(value, caret);
    if (!completion) {
      closeSlashMenuIfNeeded(state);
      return;
    }
    if (!opts.skipSlashIntent) {
      requestSlashCommandRefresh(host);
    }
    const items = getSlashCommandCompletions(completion.query, {
      inlineOnly: completion.inline,
      allowImmediateInlineCommands: !completion.skillOnly,
    }).filter(
      (command) =>
        (host.commandFilter?.(command) ?? true) &&
        (!completion.inline || command.source === "skill" || host.canRun(true, command)),
    );
    state.slashMenuCompletion = completion;
    state.slashMenuItems = [
      ...items.filter((command) => command.source !== "skill"),
      ...items.filter((command) => command.source === "skill"),
    ];
    state.slashMenuOpen = items.length > 0;
    state.slashMenuIndex = 0;
    state.slashMenuMode = "command";
    state.slashMenuCommand = null;
    state.slashMenuArgItems = [];
  }

  function beginInlineSlashArguments(
    cmd: SlashCommandDef,
    state: SlashMenuState,
    host: SlashMenuHost,
  ): boolean {
    if (
      !state.slashMenuCompletion?.inline ||
      cmd.source === "skill" ||
      !cmd.args ||
      !host.canRun(true, cmd) ||
      !host.runInlineCommand
    ) {
      return false;
    }
    state.slashMenuCommand = cmd;
    state.slashMenuIndex = 0;
    state.slashMenuItems = [];
    const argOptions = host.resolveArgOptions(cmd);
    if (argOptions.length > 0) {
      state.slashMenuMode = "args";
      state.slashMenuArgItems = argOptions;
      state.slashMenuOpen = true;
      return true;
    }
    state.slashMenuMode = "freeform-args";
    state.slashMenuArgItems = [];
    state.slashMenuOpen = false;
    return beginInlineFreeformSlashArguments(cmd.name, state, host);
  }

  function selectSlashCommand(
    cmd: SlashCommandDef,
    state: SlashMenuState,
    host: SlashMenuHost,
    completeOnly = false,
  ): void {
    const completion = state.slashMenuCompletion;
    if (host.activateComposerMode?.(cmd, completion?.inline === true)) {
      return;
    }
    if (
      !completeOnly &&
      cmd.source !== "skill" &&
      !host.canRun(true, cmd) &&
      state.slashMenuCompletion?.inline
    ) {
      return;
    }
    const inlineReplacement = cmd.source === "skill" ? `$${cmd.name}` : `/${cmd.name}`;
    if (beginInlineSlashArguments(cmd, state, host)) {
      return;
    }
    if (
      !completeOnly &&
      state.slashMenuCompletion?.inline &&
      executesInlineImmediately(cmd) &&
      host.canRun(true, cmd) &&
      host.runInlineCommand
    ) {
      resetSlashMenuState(state);
      removeInlineSlashSelection(completion, host);
      host.runInlineCommand(`/${cmd.name}`);
      return;
    }
    if (completion?.inline) {
      resetSlashMenuState(state);
      commitInlineSlashSelection(inlineReplacement, completion, host);
      return;
    }

    const argOptions = host.resolveArgOptions(cmd);
    if (argOptions.length > 0) {
      // A draft commit can synchronously render; publish the complete mode first.
      openSlashArgumentMenu(state, cmd, argOptions);
      host.commitDraft(`/${cmd.name} `);
      return;
    }
    if (completeOnly) {
      resetSlashMenuState(state);
      host.commitDraft(cmd.args ? `/${cmd.name} ` : `/${cmd.name}`);
    } else if (
      cmd.executeLocal &&
      !cmd.args &&
      // Catalog continuations and viewer suggestions do not dispatch live chat commands.
      (cmd.key !== "btw" || host.canRun(true, cmd))
    ) {
      resetSlashMenuState(state);
      host.commitDraft(`/${cmd.name}`);
      host.runCommand();
    } else {
      closeSlashMenuIfNeeded(state);
      host.commitDraft(`/${cmd.name} `);
    }
  }

  function selectSlashArg(
    arg: string,
    state: SlashMenuState,
    host: SlashMenuHost,
    run: boolean,
  ): void {
    const { slashMenuCommand: command, slashMenuCompletion: completion } = state;
    if (
      command?.source !== "skill" &&
      !host.canRun(completion?.inline === true, command ?? undefined, arg)
    ) {
      return;
    }
    const cmdName = command?.name ?? "";
    if (
      run &&
      state.slashMenuCompletion?.inline &&
      command &&
      executesInlineImmediately(command) &&
      host.canRun(true, command, arg) &&
      host.runInlineCommand
    ) {
      resetSlashMenuState(state);
      removeInlineSlashSelection(completion, host);
      host.runInlineCommand(`/${cmdName} ${arg}`);
      return;
    }
    if (completion?.inline && (!run || !command || !executesInlineImmediately(command))) {
      resetSlashMenuState(state);
      commitInlineSlashSelection(`/${cmdName} ${arg}`, completion, host);
      return;
    }
    resetSlashMenuState(state);
    host.commitDraft(`/${cmdName} ${arg}`);
    if (run) {
      host.runCommand();
    }
  }

  function submitInlineSlashArgument(state: SlashMenuState, host: SlashMenuHost): boolean {
    const command = state.slashMenuCommand;
    const completion = state.slashMenuCompletion;
    if (
      state.slashMenuMode !== "freeform-args" ||
      !completion?.inline ||
      !command ||
      !executesInlineImmediately(command) ||
      !host.runInlineCommand
    ) {
      return false;
    }
    const current = host.getTextarea()?.value ?? host.getDraft();
    const argumentStart = completion.argumentStart ?? completion.start + `/${command.name} `.length;
    const args = current.slice(argumentStart, completion.end).trim();
    if (!host.canRun(true, command, args)) {
      return false;
    }
    resetSlashMenuState(state);
    removeInlineSlashSelection(completion, host);
    host.runInlineCommand(`/${command.name}${args ? ` ${args}` : ""}`);
    return true;
  }

  function beginDirectInlineSlashArgument(state: SlashMenuState, host: SlashMenuHost): boolean {
    if (!host.runInlineCommand) {
      return false;
    }
    const current = host.getTextarea()?.value ?? host.getDraft();
    const caret = host.getTextarea()?.selectionStart ?? current.length;
    const invocation = findDirectInlineSlashArgumentInvocation(current, caret);
    if (!invocation) {
      return false;
    }
    state.slashMenuMode = "freeform-args";
    state.slashMenuCommand = invocation.command;
    state.slashMenuCompletion = invocation.completion;
    return true;
  }

  function handleInlineSlashArgKeydown(
    event: KeyboardEvent,
    state: SlashMenuState,
    host: SlashMenuHost,
    sendShortcut: ChatSendShortcut,
  ): boolean {
    if (event.key === "Escape") {
      if (state.slashMenuMode !== "freeform-args" || !state.slashMenuCompletion?.inline) {
        return false;
      }
      event.preventDefault();
      resetSlashMenuState(state);
      return true;
    }
    const sendShortcutMatches = sendShortcut === "enter" || event.metaKey || event.ctrlKey;
    if (event.key !== "Enter" || event.shiftKey || !sendShortcutMatches) {
      return false;
    }
    if (
      (state.slashMenuMode !== "freeform-args" || !state.slashMenuCompletion?.inline) &&
      !beginDirectInlineSlashArgument(state, host)
    ) {
      return false;
    }
    if (!state.slashMenuCommand || !executesInlineImmediately(state.slashMenuCommand)) {
      return false;
    }
    event.preventDefault();
    submitInlineSlashArgument(state, host);
    return true;
  }

  function handleSlashMenuKeydown(
    event: KeyboardEvent,
    state: SlashMenuState,
    host: SlashMenuHost,
  ): boolean {
    if (!state.slashMenuOpen) {
      return false;
    }
    const items = state.slashMenuMode === "args" ? state.slashMenuArgItems : state.slashMenuItems;
    return handleComposerMenuKeydown(event, {
      count: items.length,
      index: state.slashMenuIndex,
      consumeEmpty: false,
      close: () => {
        resetSlashMenuState(state);
      },
      move: (index) => {
        state.slashMenuIndex = index;
        return getActiveSlashMenuOptionId(state, host.paneId);
      },
      select: (key) => {
        if (state.slashMenuMode === "args") {
          const arg = state.slashMenuArgItems[state.slashMenuIndex];
          if (arg !== undefined) {
            selectSlashArg(arg, state, host, key === "Enter");
          }
        } else {
          const command = state.slashMenuItems[state.slashMenuIndex];
          if (command) {
            selectSlashCommand(command, state, host, key === "Tab");
          }
        }
      },
    });
  }

  return {
    state: presentation,
    update(value: string, host: SlashMenuHost) {
      let open = false;
      setState((draft) => {
        updateSlashMenu(value, draft, host);
        open = draft.slashMenuOpen;
      });
      return open;
    },
    reset: () => setState(resetSlashMenuState),
    dispose: () => {
      refreshGeneration += 1;
      refreshPending = false;
    },
    handleKeydown(event: KeyboardEvent, host: SlashMenuHost, sendShortcut?: ChatSendShortcut) {
      let handled = false;
      // Inline detection can change mode before normal menu handling in this keypress.
      setState((draft) => {
        handled =
          (sendShortcut !== undefined &&
            handleInlineSlashArgKeydown(event, draft, host, sendShortcut)) ||
          handleSlashMenuKeydown(event, draft, host);
      });
      return handled;
    },
    selectCommand: (command: SlashCommandDef, host: SlashMenuHost) =>
      setState((draft) => selectSlashCommand(command, draft, host)),
    selectArg: (arg: string, host: SlashMenuHost) =>
      setState((draft) => selectSlashArg(arg, draft, host, true)),
    hover: (index: number) =>
      setState((draft) => {
        draft.slashMenuIndex = index;
      }),
  };
}

export type SlashMenu = ReturnType<typeof createSlashMenu>;

function CommandOption(props: {
  menu: SlashMenu;
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

export function SlashMenu(props: { menu: SlashMenu; host: SlashMenuHost; draft: string }) {
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
              <For each={state().slashMenuArgItems}>
                {(arg, index) => (
                  <ComposerMenuOption
                    id={getSlashArgOptionId(
                      props.host.paneId,
                      state().slashMenuCommand?.name ?? "",
                      arg,
                    )}
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
                    <For each={group()[1]} keyed={(entry) => entry.command.name}>
                      {(entry) => (
                        <CommandOption
                          menu={props.menu}
                          host={props.host}
                          command={entry().command}
                          index={entry().index}
                          query={props.draft.slice(1)}
                        />
                      )}
                    </For>
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
