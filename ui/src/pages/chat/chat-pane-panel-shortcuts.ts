import { canPresentGatewayMethod } from "../../lib/gateway-methods.ts";
import {
  matchesShortcutCombo,
  KEYBOARD_SHORTCUT_COMBOS as combos,
} from "../../lib/keyboard-shortcut-contract.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import type { SidebarSlotId } from "./sidebar-layout-types.ts";

type PanelContext = {
  state?: Pick<ChatPageHost, "terminalAvailable" | "browserPanelAvailable" | "hello">;
  desktopAvailable?: boolean;
  discussion?: unknown;
  discussionAvailable?: boolean;
  dashboardAvailable: () => boolean;
};

function panel(
  slot: SidebarSlotId,
  combo: (typeof combos)[keyof typeof combos],
  available: (context: PanelContext) => boolean = () => true,
) {
  return { slot, combo, available };
}

export const SIDEBAR_PANEL_SHORTCUTS = {
  terminal: panel("terminal", combos.terminalPanel, (c) => c.state?.terminalAvailable === true),
  browser: panel("browser", combos.browserPanel, (c) => c.state?.browserPanelAvailable === true),
  workspace: panel("workspace", combos.workspaceFiles),
  companion: panel("companion", combos.sideChat, (c) =>
    canPresentGatewayMethod(c.state, "sessions.companion.state", "operator.read"),
  ),
  desktop: panel("desktop", combos.desktopPanel, (c) => c.desktopAvailable === true),
  discussion: panel(
    "discussion",
    combos.discussionPanel,
    (c) => c.discussion != null && c.discussionAvailable === true,
  ),
  dashboard: panel("dashboard", combos.dashboardPanel, (c) => c.dashboardAvailable()),
  detail: panel("detail", combos.reviewPanel),
  context: undefined,
  conversation: undefined,
  "link-reader": undefined,
  portal: undefined,
  subagents: undefined,
  processes: undefined,
};

/** Keyboard and panel metadata use the same availability policy. */
export function resolveSidebarPanelShortcut(
  event: KeyboardEvent,
  context: () => PanelContext,
): SidebarSlotId | undefined {
  const shortcut = Object.values(SIDEBAR_PANEL_SHORTCUTS).find(
    (entry) => entry && matchesShortcutCombo(entry.combo, event),
  );
  return shortcut?.available(context()) ? shortcut.slot : undefined;
}
