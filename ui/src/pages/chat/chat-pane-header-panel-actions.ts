import { t } from "../../i18n/index.ts";
import { registerChatSessionEnglish } from "../../i18n/locales/en-chat-session.ts";
import type { sidebarPanelDefinitions } from "./chat-pane-embedded-panels.ts";
import type { createChatPaneRails } from "./chat-pane-rails.ts";
import type { HeaderPanelAction } from "./components/chat-header-panel-actions.tsx";
import { isSidebarSlotVisible, type SidebarLayout, type SidebarSlotId } from "./sidebar-layout.ts";

registerChatSessionEnglish();

type PanelControls = {
  openPanelSlot: (slot: SidebarSlotId) => void;
  closePanelSlot: (slot: SidebarSlotId) => void;
};

export function buildHeaderPanelActions(input: {
  sessionWorkspace: ReturnType<typeof createChatPaneRails>["sessionWorkspace"];
  callbacks: Record<
    "terminal" | "browser" | "desktop" | "discussion" | "changes" | "files" | "companion",
    () => void
  >;
  desktopPanelAvailable: boolean;
  discussion: { label: string; active?: boolean; onToggle: () => void } | null | undefined;
  usesMobileHost: boolean;
  sessionRailVisible: boolean;
  subagentsVisible: boolean;
  processesVisible: boolean;
  catalog: boolean;
  currentLayout: SidebarLayout | undefined;
  panelDefinitions: ReturnType<typeof sidebarPanelDefinitions>;
  panelControlsAvailable: boolean;
  isPanelVisible: (slot: SidebarSlotId) => boolean;
  readPanelControls: () => PanelControls | undefined;
  requestBackgroundPanel: (slot: "subagents" | "processes") => void;
}): HeaderPanelAction[] {
  const {
    sessionWorkspace,
    callbacks,
    desktopPanelAvailable,
    discussion,
    usesMobileHost,
    sessionRailVisible,
    subagentsVisible,
    processesVisible,
    catalog,
    currentLayout,
    panelDefinitions,
    panelControlsAvailable,
    isPanelVisible,
    readPanelControls,
    requestBackgroundPanel,
  } = input;
  const actions: HeaderPanelAction[] = [];
  const represented = new Set<SidebarSlotId>();
  const addPanelAction = (slot: SidebarSlotId | null, action: HeaderPanelAction) => {
    actions.push({
      ...action,
      shortcut: panelDefinitions.find((definition) => definition.slot === slot)?.shortcut,
    });
    if (slot) {
      represented.add(slot);
    }
  };
  for (const [id, label, icon, onActivate] of [
    [
      "terminal",
      t("terminal.toggle"),
      "terminal",
      sessionWorkspace.onToggleTerminal && callbacks.terminal,
    ],
    [
      "browser",
      t("browser.toggle"),
      "globe",
      sessionWorkspace.onToggleBrowser && callbacks.browser,
    ],
    [
      "desktop",
      t("desktop.toggle"),
      "monitor",
      desktopPanelAvailable && sessionWorkspace.onToggleDesktop && callbacks.desktop,
    ],
    [
      "discussion",
      discussion?.label ?? "",
      "messageSquare",
      discussion && (usesMobileHost ? discussion.onToggle : callbacks.discussion),
    ],
    [
      "changes",
      t("chat.sessionDiff.show"),
      "diff",
      sessionWorkspace.onOpenDiff && callbacks.changes,
    ],
  ] as const) {
    if (onActivate) {
      addPanelAction(id === "changes" ? null : id, {
        id,
        label,
        icon,
        onActivate,
        ...(id === "discussion" ? { active: discussion?.active } : {}),
      });
    }
  }
  addPanelAction("workspace", {
    id: "session-files",
    label: t(
      sessionWorkspace.collapsed ? "chat.workspaceFiles.showFiles" : "chat.workspaceFiles.collapse",
    ),
    icon: "fileText",
    active: !sessionWorkspace.collapsed,
    onActivate: callbacks.files,
  });
  addPanelAction("companion", {
    id: "session-companion",
    label: t(sessionRailVisible ? "chat.rail.collapse" : "chat.rail.show"),
    icon: "spark",
    active: sessionRailVisible,
    onActivate: callbacks.companion,
  });
  if (!catalog) {
    for (const slot of ["subagents", "processes"] as const) {
      const subagents = slot === "subagents";
      addPanelAction(slot, {
        id: `session-${slot}`,
        label: t(subagents ? "chat.subagentsPanel.title" : "chat.processesPanel.title"),
        icon: subagents ? "bot" : "terminal",
        active: subagents ? subagentsVisible : processesVisible,
        onActivate: () => requestBackgroundPanel(slot),
      });
    }
  }
  for (const definition of panelDefinitions) {
    if (
      !panelControlsAvailable ||
      !definition.available ||
      represented.has(definition.slot) ||
      definition.slot === "conversation"
    ) {
      continue;
    }
    const slot = definition.slot;
    addPanelAction(slot, {
      id: `panel-${slot}`,
      label: definition.label,
      icon: definition.icon,
      active: Boolean(currentLayout && isSidebarSlotVisible(currentLayout, slot)),
      onActivate: () => {
        if (isPanelVisible(slot)) {
          readPanelControls()?.closePanelSlot(slot);
        } else {
          readPanelControls()?.openPanelSlot(slot);
        }
      },
    });
  }
  return actions;
}
