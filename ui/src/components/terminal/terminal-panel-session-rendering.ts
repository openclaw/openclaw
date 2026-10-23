import type { GhosttyTerminalController } from "@openclaw/libterminal/browser";
import { THEME_TERMINAL_COLOR_TOKENS } from "../../../../packages/gateway-protocol/src/theme.ts";
import {
  forceTerminalRender,
  type TerminalPanelSessionTab,
} from "./terminal-panel-session-types.ts";
import { terminalTheme } from "./terminal-theme.ts";

const appliedTerminalColors = new WeakMap<GhosttyTerminalController, string>();

export function applyTerminalTheme(
  controller: GhosttyTerminalController,
  theme: ReturnType<typeof terminalTheme>,
): void {
  const term = controller.terminal;
  if (!term.renderer || !term.wasmTerm) {
    return;
  }
  // The parser owns indexed colors, including scrollback. Updating its native
  // defaults leaves partially received PTY escape sequences untouched.
  const rgb = (value: string) => Number.parseInt(value.slice(1), 16);
  const colors = {
    foreground: rgb(theme.foreground),
    background: rgb(theme.background),
    cursor: rgb(theme.cursor),
    palette: THEME_TERMINAL_COLOR_TOKENS.map(([key]) => rgb(theme[key])),
  };
  const identity = JSON.stringify(colors);
  // Unrelated preference publications must not reset an application's OSC colors.
  if (appliedTerminalColors.get(controller) !== identity) {
    term.wasmTerm.setThemeColors(colors);
    appliedTerminalColors.set(controller, identity);
  }
  term.renderer.setTheme(theme);
  forceTerminalRender(controller);
}

export async function focusTerminalSession(
  tab: TerminalPanelSessionTab | undefined,
  rendered: Promise<unknown>,
): Promise<void> {
  // Refit and repaint after the container becomes visible. A same-size tab
  // switch otherwise leaves the newly shown canvas without dirty rows.
  await rendered;
  if (tab) {
    tab.controller.fit();
    forceTerminalRender(tab.controller);
    tab.controller.terminal.focus();
  }
}

export function updateTerminalSessionTheme(
  tabs: readonly TerminalPanelSessionTab[],
  themeMode: "dark" | "light",
): void {
  // Unopened panels still observe theme changes; resolve colors only for live renderers.
  let theme: ReturnType<typeof terminalTheme> | undefined;
  for (const tab of tabs) {
    const term = tab.controller.terminal;
    if (term.renderer && term.wasmTerm) {
      applyTerminalTheme(tab.controller, (theme ??= terminalTheme(themeMode)));
    }
  }
}

export function reattachTerminalSessionHosts(
  tabs: readonly TerminalPanelSessionTab[],
  activeId: string | null,
  viewport: Element | null,
): void {
  if (!viewport) {
    return;
  }
  // Hiding the panel removes its viewport, which detaches each session's Ghostty
  // host. Re-attach live hosts whenever the viewport is rendered so a
  // hide/show cycle keeps the terminals intact instead of blanking them.
  for (const tab of tabs) {
    if (tab.host.parentElement !== viewport) {
      viewport.append(tab.host);
    }
  }
  const activeTab = tabs.find((tab) => tab.id === activeId);
  if (activeTab) {
    activeTab.controller.fit();
    // FitAddon skips unchanged dimensions; force dirty-row rendering to
    // repair a canvas that was detached while the panel was hidden.
    forceTerminalRender(activeTab.controller);
  }
}
