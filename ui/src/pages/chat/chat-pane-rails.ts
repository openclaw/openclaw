import { isDesktopPanelAvailable } from "../../app/panel-availability.ts";
import { loadSettings } from "../../app/settings.ts";
import { canonicalUiSessionKeyForPersistence } from "../../lib/sessions/session-key.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import { selectedChatSessionRow } from "./chat-state-route.ts";
import {
  createBackgroundTasksProps,
  refreshBackgroundTasks,
} from "./components/chat-background-tasks.ts";
import { clearSessionWorkspacePreviews } from "./components/chat-session-workspace-state.ts";
import { createSessionWorkspaceProps } from "./components/chat-session-workspace.ts";
import {
  closeSlot,
  isSidebarSlotVisible,
  openSlot,
  openDashboardPresentation,
  type SidebarSlotId,
} from "./sidebar-layout.ts";

type ChatPaneSidebarLayout = Parameters<typeof isSidebarSlotVisible>[0];
type ChatPaneGatewaySnapshot = Parameters<typeof isDesktopPanelAvailable>[0];

/** Shared by rail clicks and keyboard shortcuts; opening a panel is not a preference write. */
export function openPreferredSidebarPanel(
  state: ChatPageHost,
  layout: ChatPaneSidebarLayout,
  slot: SidebarSlotId,
): ChatPaneSidebarLayout {
  if (slot === "tasks") {
    refreshBackgroundTasks(state);
  }
  if (slot !== "dashboard") {
    return openSlot(layout, slot);
  }
  const saved =
    loadSettings().sidebarSessionLayouts?.[
      canonicalUiSessionKeyForPersistence(state, state.sessionKey)
    ];
  const override = saved ? saved.dashboardPresentationOverride : null;
  const next = { ...layout, dashboardPresentationOverride: override };
  return saved && override === undefined
    ? openSlot(next, slot)
    : openDashboardPresentation(
        next,
        override ?? selectedChatSessionRow(state)?.boardPresentation ?? "split",
      );
}

export function releaseAttachmentWorkspaceOwner(state: ChatPageHost, slot: SidebarSlotId): void {
  // Closing the Files slot releases its previews, never their underlying files.
  if (slot === "workspace") {
    clearSessionWorkspacePreviews(state);
  }
}

/** Builds the two rail models and their shared sidebar slot controls. */
export function createChatPaneRails(params: {
  state: ChatPageHost;
  sidebarLayout: ChatPaneSidebarLayout;
  presentationId: string;
  presented: boolean;
  gatewaySnapshot: ChatPaneGatewaySnapshot;
  setObserverVisibility: (visible: boolean) => void;
  updateSidebarLayout: ChatPageHost["updateSidebarLayout"];
}) {
  const { state, sidebarLayout } = params;
  const isPanelVisible = (slot: SidebarSlotId) => isSidebarSlotVisible(sidebarLayout, slot);
  const openPanelSlot = (slot: SidebarSlotId) => {
    params.updateSidebarLayout(openPreferredSidebarPanel(state, sidebarLayout, slot));
    if (slot === "companion") {
      params.setObserverVisibility(true);
    }
  };
  const closePanelSlot = (slot: SidebarSlotId) => {
    if (slot === "companion") {
      params.setObserverVisibility(false);
    }
    releaseAttachmentWorkspaceOwner(state, slot);
    params.updateSidebarLayout(closeSlot(sidebarLayout, slot));
  };
  const togglePanelSlot = (slot: SidebarSlotId) =>
    isPanelVisible(slot) ? closePanelSlot(slot) : openPanelSlot(slot);
  const sessionWorkspaceBase = createSessionWorkspaceProps(state, {
    draftScope: params.presentationId,
    expanded: isSidebarSlotVisible(sidebarLayout, "workspace"),
    narrowLayout: false,
    presented: params.presented,
  });
  const sessionWorkspace = {
    ...sessionWorkspaceBase,
    collapsed: !isPanelVisible("workspace"),
    narrowLayout: false,
    onToggleCollapsed: () => togglePanelSlot("workspace"),
    onToggleTerminal: state.terminalAvailable ? () => togglePanelSlot("terminal") : undefined,
    onToggleBrowser: state.browserPanelAvailable ? () => togglePanelSlot("browser") : undefined,
    onToggleDesktop: isDesktopPanelAvailable(params.gatewaySnapshot)
      ? () => togglePanelSlot("desktop")
      : undefined,
  };
  // The persisted Tasks panel owns selection. List/detail navigation changes
  // only that identity while keeping the visible panel's geometry and focus.
  const showTasks = (taskId?: string) => {
    const current = state.sidebarLayout;
    const next = isSidebarSlotVisible(current, "tasks")
      ? structuredClone(current)
      : openSlot(current, "tasks");
    const panel = next.columns
      .flatMap((column) => column.panels)
      .find((entry) => entry.slot === "tasks");
    if (panel) {
      if (taskId) {
        panel.taskId = taskId;
      } else {
        delete panel.taskId;
      }
    }
    params.updateSidebarLayout(next);
  };
  const backgroundTasksBase = createBackgroundTasksProps(state, {
    narrowLayout: false,
    selectedTaskId: sidebarLayout.columns
      .flatMap((column) => column.panels)
      .find((panel) => panel.slot === "tasks")?.taskId,
    onOpenTaskDetail: (task) => showTasks(task.id),
    onOpenTaskList: () => showTasks(),
    presented: params.presented,
  });
  const backgroundTasks = {
    ...backgroundTasksBase,
    collapsed: !isPanelVisible("tasks"),
    narrowLayout: false,
    onToggleCollapsed: () => togglePanelSlot("tasks"),
  };
  return {
    backgroundTasks,
    closePanelSlot,
    openPanelSlot,
    sessionWorkspace,
  };
}
