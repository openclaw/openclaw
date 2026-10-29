import {
  COMMAND_PALETTE_OPEN_EVENT,
  type CommandPaletteElement,
} from "../components/command-palette-contract.ts";
import {
  BROWSER_PANEL_TOGGLE_EVENT,
  CUSTODIAN_PANEL_TOGGLE_EVENT,
  DEBUG_OVERLAY_REQUEST_EVENT,
  DESKTOP_PANEL_TOGGLE_EVENT,
  HOME_PANEL_TOGGLE_EVENT,
  KEYBOARD_SHORTCUTS_REQUEST_EVENT,
  LINK_READER_PANEL_TOGGLE_EVENT,
  TERMINAL_PANEL_TOGGLE_EVENT,
  TERMINAL_PANEL_DOCK_BOTTOM_EVENT,
} from "../components/panel-toggle-contract.ts";
import type { KeyboardShortcutsDialogElement } from "../lib/keyboard-shortcut-contract.ts";
import type { DebugOverlayElement } from "../pages/debug/debug-overlay-state.ts";
import { SHELL_APPROVALS_OPEN_EVENT, type LazyShellEvent } from "./lazy-shell-action.ts";

export const SHELL_COMPONENT_TAGS = {
  palette: "openclaw-command-palette",
  debug: "openclaw-debug-overlay",
  terminal: "openclaw-terminal-panel",
  browser: "openclaw-browser-panel",
  desktop: "openclaw-desktop-panel",
  "link-reader": "openclaw-link-reader-panel",
  shortcuts: "openclaw-keyboard-shortcuts-dialog",
  approvals: "openclaw-exec-approval",
} as const;
export type ShellComponent = keyof typeof SHELL_COMPONENT_TAGS;

export interface ShellOwnedElements {
  commandPalette?: CommandPaletteElement;
  approvalOverlay?: HTMLElement & { show(): void; dialogOpen?: boolean };
  debugOverlay?: DebugOverlayElement;
  pendingDebugOverlayFrame?: HTMLElement;
  keyboardShortcuts?: KeyboardShortcutsDialogElement;
  assistantPanel?: HTMLElement;
  browserPanel?: HTMLElement;
  desktopPanel?: HTMLElement;
  linkReaderPanel?: HTMLElement;
}

export function shellComponentForAction(event: LazyShellEvent): ShellComponent | undefined {
  switch (event.eventType) {
    case COMMAND_PALETTE_OPEN_EVENT:
      return "palette";
    case DEBUG_OVERLAY_REQUEST_EVENT:
      return "debug";
    case TERMINAL_PANEL_TOGGLE_EVENT:
    case TERMINAL_PANEL_DOCK_BOTTOM_EVENT:
      return "terminal";
    case BROWSER_PANEL_TOGGLE_EVENT:
      return "browser";
    case DESKTOP_PANEL_TOGGLE_EVENT:
      return "desktop";
    case LINK_READER_PANEL_TOGGLE_EVENT:
      return "link-reader";
    case KEYBOARD_SHORTCUTS_REQUEST_EVENT:
      return "shortcuts";
    case SHELL_APPROVALS_OPEN_EVENT:
      return "approvals";
    case CUSTODIAN_PANEL_TOGGLE_EVENT:
    case HOME_PANEL_TOGGLE_EVENT:
      return undefined;
  }
  return undefined;
}

export interface ShellComponentHost {
  readonly elements: ShellOwnedElements;
  readonly terminalPanel?: HTMLElement;
  readonly pendingShellAction: LazyShellEvent | null;
  isShellComponentRequested(component: ShellComponent): boolean;
  cancelShellComponentRequest(component: ShellComponent): void;
  retryPendingLazyAction(canReload: () => boolean): Promise<boolean>;
  shellComponentMounted(element: HTMLElement): void;
}

/** Embedded route panels never accept shell dock replay. */
export function shellComponentElement(
  host: Pick<ShellComponentHost, "elements" | "terminalPanel">,
  component: ShellComponent,
): HTMLElement | null {
  return (
    [host.terminalPanel, ...Object.values(host.elements)].find(
      (element) => element?.isConnected && element.localName === SHELL_COMPONENT_TAGS[component],
    ) ?? null
  );
}
