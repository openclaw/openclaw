import { createStore } from "solid-js";
import { handleComposerMenuKeydown } from "../../../components/composer-menu.ts";
import {
  getSkillCommandCompletions,
  getSkillDisplayName,
  getSlashCommandDescription,
  type SlashCommandDef,
} from "../../../lib/chat/commands.ts";
import { paneDomId } from "./chat-composer-dom.ts";

// Display titles may use any script (including NFD combining marks);
// command tokens stay ASCII after selection.
const SKILL_MENTION_CHAR = /[\p{L}\p{M}\p{N}_:-]/u;
// Documented shell variables ($HOME/$PATH/$EDITOR) stay ordinary text.
const UPPERCASE_SHELL_VARIABLE = /^[A-Z_][A-Z0-9_]*$/;

type SkillMentionTarget = {
  start: number;
  end: number;
  query: string;
};

export type SkillMenuState = {
  skillMenuOpen: boolean;
  skillMenuItems: SlashCommandDef[];
  skillMenuIndex: number;
  skillMenuTarget: SkillMentionTarget | null;
  skillCommandRefreshPending: boolean;
};

export type SkillMenuHost = {
  paneId: string;
  getDraft: () => string;
  commitDraft: (next: string) => void;
  getTextarea: () => HTMLTextAreaElement | null;
  refreshCommands?: () => void | Promise<void>;
};

function isEscapedReference(value: string, dollar: number): boolean {
  let backslashes = 0;
  for (let cursor = dollar - 1; cursor >= 0 && value[cursor] === "\\"; cursor -= 1) {
    backslashes += 1;
  }
  return backslashes % 2 === 1;
}

function findSkillMentionTarget(value: string, caret: number): SkillMentionTarget | null {
  const safeCaret = Math.max(0, Math.min(caret, value.length));
  let start = safeCaret;
  while (start > 0 && SKILL_MENTION_CHAR.test(value[start - 1] ?? "")) {
    start -= 1;
  }
  if (start === 0 || value[start - 1] !== "$") {
    return null;
  }
  const dollar = start - 1;
  if (isEscapedReference(value, dollar)) {
    return null;
  }
  let end = safeCaret;
  while (end < value.length && SKILL_MENTION_CHAR.test(value[end] ?? "")) {
    end += 1;
  }
  let referenceEnd = end;
  while (referenceEnd > start && value[referenceEnd - 1] === ":") {
    referenceEnd -= 1;
  }
  const query = value.slice(start, referenceEnd);
  if (query.length > 0) {
    // Preserve literal uppercase ASCII shell variables (skills docs: $HOME, $PATH, $EDITOR).
    if (UPPERCASE_SHELL_VARIABLE.test(query)) {
      return null;
    }
    // Require a letter so bare "$123"/"$:" do not open the menu on every dollar.
    if (!/\p{L}/u.test(query)) {
      return null;
    }
  }
  return { start: dollar, end: referenceEnd, query };
}

export function skillOptionId(paneId: string, command: SlashCommandDef): string {
  const name = command.name.replace(/[^a-z0-9_-]+/giu, "-").replace(/^-+|-+$/gu, "");
  return paneDomId(paneId, `skill-option-${name || "skill"}`);
}

export function isSkillMenuVisible(state: SkillMenuState): boolean {
  return (
    state.skillMenuOpen && (state.skillMenuItems.length > 0 || state.skillCommandRefreshPending)
  );
}

export function getActiveSkillMenuOptionId(state: SkillMenuState, paneId: string): string | null {
  if (!isSkillMenuVisible(state) || state.skillCommandRefreshPending) {
    return null;
  }
  const command = state.skillMenuItems[state.skillMenuIndex];
  return command ? skillOptionId(paneId, command) : null;
}

export function getActiveSkillMenuOptionLabel(state: SkillMenuState): string {
  if (state.skillCommandRefreshPending) {
    return "";
  }
  const command = state.skillMenuItems[state.skillMenuIndex];
  return command ? `${getSkillDisplayName(command)} ${getSlashCommandDescription(command)}` : "";
}

export function createSkillMenu() {
  let generation = 0;
  let refreshTargetStart: number | null = null;
  const [presentation, setState] = createStore<SkillMenuState>({
    skillMenuOpen: false,
    skillMenuItems: [],
    skillMenuIndex: 0,
    skillMenuTarget: null,
    skillCommandRefreshPending: false,
  });

  function resetSkillMenuState(state: SkillMenuState): void {
    generation += 1;
    state.skillCommandRefreshPending = false;
    refreshTargetStart = null;
    state.skillMenuOpen = false;
    state.skillMenuItems = [];
    state.skillMenuIndex = 0;
    state.skillMenuTarget = null;
  }

  function requestSkillCommandRefresh(state: SkillMenuState, host: SkillMenuHost): void {
    if (!host.refreshCommands || state.skillCommandRefreshPending) {
      return;
    }
    const refresh = host.refreshCommands();
    if (!refresh) {
      return;
    }
    const requestGeneration = ++generation;
    state.skillCommandRefreshPending = true;
    void refresh
      .catch(() => undefined)
      .finally(() => {
        if (generation !== requestGeneration) {
          return;
        }
        setState((draft) => {
          draft.skillCommandRefreshPending = false;
          const value = host.getDraft();
          const caret = host.getTextarea()?.selectionStart ?? value.length;
          updateSkillMenu(value, caret, draft, host, { skipRefresh: true });
        });
      });
  }

  function updateSkillMenu(
    value: string,
    caret: number,
    state: SkillMenuState,
    host: SkillMenuHost,
    opts: { skipRefresh?: boolean } = {},
  ): void {
    const target = value.trimStart().startsWith("/") ? null : findSkillMentionTarget(value, caret);
    if (!target) {
      if (state.skillMenuTarget !== null) {
        resetSkillMenuState(state);
      }
      return;
    }
    if (!opts.skipRefresh && refreshTargetStart !== target.start) {
      refreshTargetStart = target.start;
      requestSkillCommandRefresh(state, host);
    }
    const items = getSkillCommandCompletions(target.query);
    state.skillMenuTarget = target;
    state.skillMenuItems = items;
    state.skillMenuIndex = Math.min(state.skillMenuIndex, Math.max(0, items.length - 1));
    state.skillMenuOpen = items.length > 0 || state.skillCommandRefreshPending;
  }

  function selectSkillMention(
    command: SlashCommandDef,
    state: SkillMenuState,
    host: SkillMenuHost,
  ): void {
    if (state.skillCommandRefreshPending) {
      return;
    }
    const textarea = host.getTextarea();
    const current = textarea?.value ?? host.getDraft();
    const currentCaret = textarea?.selectionStart ?? state.skillMenuTarget?.end ?? current.length;
    const target = findSkillMentionTarget(current, currentCaret);
    if (!target) {
      resetSkillMenuState(state);
      return;
    }
    const suffix = target.end === current.length ? " " : "";
    const replacement = `$${command.name}${suffix}`;
    const next = `${current.slice(0, target.start)}${replacement}${current.slice(target.end)}`;
    const retainedBeforeCaret = Math.max(0, currentCaret - target.end);
    const nextCaret = target.start + replacement.length + retainedBeforeCaret;
    resetSkillMenuState(state);
    host.commitDraft(next);
    queueMicrotask(() => {
      const currentTextarea = host.getTextarea();
      if (!currentTextarea) {
        return;
      }
      currentTextarea.focus({ preventScroll: true });
      currentTextarea.setSelectionRange(nextCaret, nextCaret);
    });
  }

  return {
    state: presentation,
    update(value: string, caret: number, host: SkillMenuHost) {
      let open = false;
      setState((draft) => {
        updateSkillMenu(value, caret, draft, host);
        open = draft.skillMenuOpen;
      });
      return open;
    },
    reset: () => setState(resetSkillMenuState),
    dispose: () => {
      generation += 1;
    },
    handleKeydown(event: KeyboardEvent, host: SkillMenuHost) {
      let handled = false;
      setState((draft) => {
        if (!draft.skillMenuOpen) {
          return;
        }
        const items = draft.skillCommandRefreshPending ? [] : draft.skillMenuItems;
        handled = handleComposerMenuKeydown(event, {
          count: items.length,
          index: draft.skillMenuIndex,
          consumeEmpty: true,
          close: () => {
            resetSkillMenuState(draft);
          },
          move: (index) => {
            draft.skillMenuIndex = index;
            return getActiveSkillMenuOptionId(draft, host.paneId);
          },
          select: () => {
            const command = items[draft.skillMenuIndex];
            if (command) {
              selectSkillMention(command, draft, host);
            }
          },
        });
      });
      return handled;
    },
    select: (command: SlashCommandDef, host: SkillMenuHost) =>
      setState((draft) => selectSkillMention(command, draft, host)),
    hover: (index: number) =>
      setState((draft) => {
        draft.skillMenuIndex = index;
      }),
  };
}

export type SkillMenu = ReturnType<typeof createSkillMenu>;
