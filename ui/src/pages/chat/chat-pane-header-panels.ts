import { icons } from "../../components/icons.ts";
import { t } from "../../i18n/index.ts";
import type { createChatPaneRails } from "./chat-pane-rails.ts";
import type { HeaderMenuQuickAction } from "./components/chat-header-session-menu.ts";

type PanelCallbacks = Record<
  | "terminal"
  | "browser"
  | "desktop"
  | "discussion"
  | "changes"
  | "files"
  | "companion"
  | "subagents"
  | "processes",
  () => void
>;

type PanelWorkspace = Pick<
  ReturnType<typeof createChatPaneRails>["sessionWorkspace"],
  "onToggleTerminal" | "onToggleBrowser" | "onToggleDesktop" | "onOpenDiff" | "collapsed"
>;

/** One ordered projection for the chat header's panel menu. The pane retains action ownership. */
export function createChatHeaderPanelActions(params: {
  sessionWorkspace: PanelWorkspace;
  desktopPanelAvailable: boolean;
  discussion: { label: string; active?: boolean } | null | undefined;
  modifiedFiles: number;
  sessionRailVisible: boolean;
  subagentsVisible: boolean;
  processesVisible: boolean;
  catalog: boolean;
  callbacks: PanelCallbacks;
}): HeaderMenuQuickAction[] {
  const {
    sessionWorkspace,
    desktopPanelAvailable,
    discussion,
    modifiedFiles,
    sessionRailVisible,
    subagentsVisible,
    processesVisible,
    catalog,
    callbacks,
  } = params;
  const actions: HeaderMenuQuickAction[] = (
    [
      [
        "terminal",
        t("terminal.toggle"),
        icons.terminal,
        sessionWorkspace.onToggleTerminal && callbacks.terminal,
      ],
      [
        "browser",
        t("browser.toggle"),
        icons.globe,
        sessionWorkspace.onToggleBrowser && callbacks.browser,
      ],
      [
        "desktop",
        t("desktop.toggle"),
        icons.monitor,
        desktopPanelAvailable && sessionWorkspace.onToggleDesktop ? callbacks.desktop : undefined,
      ],
      [
        "discussion",
        discussion?.label ?? "",
        icons.messageSquare,
        discussion && callbacks.discussion,
      ],
      [
        "changes",
        t("chat.sessionDiff.show"),
        icons.diff,
        sessionWorkspace.onOpenDiff && callbacks.changes,
      ],
    ] as const
  ).flatMap(([id, label, icon, onActivate]) =>
    onActivate
      ? [
          {
            id,
            label,
            icon,
            onActivate,
            ...(id === "discussion" ? { active: discussion?.active } : {}),
          },
        ]
      : [],
  );
  actions.push({
    id: "session-files",
    label: t(
      sessionWorkspace.collapsed ? "chat.workspaceFiles.showFiles" : "chat.workspaceFiles.collapse",
    ),
    icon: icons.fileText,
    active: !sessionWorkspace.collapsed,
    badge: modifiedFiles,
    onActivate: callbacks.files,
  });
  actions.push({
    id: "session-companion",
    label: t(sessionRailVisible ? "chat.rail.collapse" : "chat.rail.show"),
    icon: icons.spark,
    active: sessionRailVisible,
    onActivate: callbacks.companion,
  });
  if (!catalog) {
    actions.push({
      id: "session-subagents",
      label: t("chat.subagentsPanel.title"),
      icon: icons.bot,
      active: subagentsVisible,
      onActivate: callbacks.subagents,
    });
  }
  if (!catalog) {
    actions.push({
      id: "session-processes",
      label: t("chat.processesPanel.title"),
      icon: icons.terminal,
      active: processesVisible,
      onActivate: callbacks.processes,
    });
  }
  return actions;
}
