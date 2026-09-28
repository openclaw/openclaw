import {
  KEYBOARD_SHORTCUT_COMBOS,
  matchesShortcutCombo,
} from "../lib/keyboard-shortcut-contract.ts";
import type { SessionCommand, SessionCommandKind } from "./session-commands.ts";

export const COMMAND_PALETTE_DIALOG_STYLE =
  "--openclaw-modal-width: min(740px, calc(100vw - 32px));";

export type CommandPaletteInputSnapshot = Pick<
  HTMLTextAreaElement,
  "value" | "selectionStart" | "selectionEnd" | "selectionDirection"
>;

export type CommandPaletteOpenInput = CommandPaletteInputSnapshot & {
  returnFocus?: HTMLElement | null;
  submitRequested?: true;
  /** Position of an explicitly typed @ retained only during the cold-input handoff. */
  mentionTrigger?: number;
  /** Clipboard Files remain in memory until the canonical draft admits and reads them. */
  imageFiles?: readonly File[];
};

/** Read the live cold input when replacement focus is accepted; undefined means retired. */
export type CommandPaletteInputHandoff = () => CommandPaletteOpenInput | undefined;

export const COMMAND_PALETTE_TARGET_EVENT = "openclaw-command-palette-target";
export const COMMAND_PALETTE_OPEN_EVENT = "openclaw:command-palette-open";
export const SHELL_NAV_DRAWER_TOGGLE_EVENT = "openclaw:shell-nav-drawer-toggle";

export type ShellNavDrawerToggleDetail = {
  trigger: HTMLElement;
};

export function shellNavDrawerTriggerFromEvent(event: Event): HTMLElement | undefined {
  const detail: unknown = event instanceof CustomEvent ? event.detail : undefined;
  const trigger =
    detail && typeof detail === "object" && "trigger" in detail ? detail.trigger : null;
  return trigger instanceof HTMLElement ? trigger : undefined;
}

export function isCommandPaletteShortcut(event: KeyboardEvent): boolean {
  return matchesShortcutCombo(KEYBOARD_SHORTCUT_COMBOS.commandPalette, event);
}

/** The target pane's session actions; the pane revalidates each command when it runs. */
export type CommandPaletteSessionCommands = {
  list: () => readonly SessionCommand[];
  run: (kind: SessionCommandKind) => void;
};

export type CommandPaletteTargetDetail = {
  owner: Element;
  onSlashCommand: ((command: string) => void) | null;
  sessionCommands: CommandPaletteSessionCommands | null;
};

function isCommandPaletteSessionCommands(value: unknown): value is CommandPaletteSessionCommands {
  return (
    value !== null &&
    typeof value === "object" &&
    "list" in value &&
    typeof value.list === "function" &&
    "run" in value &&
    typeof value.run === "function"
  );
}

function isCommandPaletteTargetDetail(value: unknown): value is CommandPaletteTargetDetail {
  return (
    value !== null &&
    typeof value === "object" &&
    "owner" in value &&
    value.owner instanceof Element &&
    "onSlashCommand" in value &&
    (value.onSlashCommand === null || typeof value.onSlashCommand === "function") &&
    "sessionCommands" in value &&
    (value.sessionCommands === null || isCommandPaletteSessionCommands(value.sessionCommands))
  );
}

export function applyCommandPaletteTargetEvent(
  host: HTMLElement & {
    commandPaletteTarget: CommandPaletteTargetDetail | undefined;
    requestUpdate(): void;
  },
  event: Event,
): void {
  const detail: unknown = event instanceof CustomEvent ? event.detail : undefined;
  if (!isCommandPaletteTargetDetail(detail)) {
    return;
  }
  host.commandPaletteTarget = detail.onSlashCommand
    ? detail
    : host.commandPaletteTarget?.owner === detail.owner
      ? undefined
      : host.commandPaletteTarget;
  host.requestUpdate();
}

export type CommandPaletteElement = HTMLElement & {
  custodianAvailable: boolean;
  desktopAvailable: boolean;
  isOpen: boolean;
  openPalette: (input?: CommandPaletteOpenInput | CommandPaletteInputHandoff) => void;
  togglePalette: () => void;
};
