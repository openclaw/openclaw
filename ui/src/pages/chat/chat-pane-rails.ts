import { isDesktopPanelAvailable } from "../../app/panel-availability.ts";
import { loadSettings } from "../../app/settings.ts";
import { canonicalUiSessionKeyForPersistence } from "../../lib/sessions/session-key.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import { selectedChatSessionRow } from "./chat-state-route.ts";
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

/** Shared by rail clicks and keyboard shortcuts; opening a panel is not a preference write. */
export function openPreferredSidebarPanel(
  state: ChatPageHost,
  layout: ChatPaneSidebarLayout,
  slot: SidebarSlotId,
): ChatPaneSidebarLayout {
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

export function createChatPaneRails(params: {
  state: ChatPageHost;
  sidebarLayout: ChatPaneSidebarLayout;
  /** Visibility only; all mutations still use sidebarLayout. */
  visibleLayout?: ChatPaneSidebarLayout;
  presentationId: string;
  presentation?: "desktop" | "mobile";
  sessionTitle?: string;
  paneLabel?: string;
  presented: boolean;
  gatewaySnapshot: Parameters<typeof isDesktopPanelAvailable>[0];
  setObserverVisibility: (visible: boolean) => void;
  updateSidebarLayout: ChatPageHost["updateSidebarLayout"];
  onOpenPanel?: (slot: SidebarSlotId) => void;
}) {
  const { state, sidebarLayout } = params;
  const isPanelVisible = (slot: SidebarSlotId) =>
    isSidebarSlotVisible(params.visibleLayout ?? sidebarLayout, slot);
  const openPanelSlot = (slot: SidebarSlotId) => {
    params.updateSidebarLayout(openPreferredSidebarPanel(state, sidebarLayout, slot));
    if (slot === "companion") {
      params.setObserverVisibility(true);
    }
    params.onOpenPanel?.(slot);
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
  return {
    closePanelSlot,
    openPanelSlot,
    sessionWorkspace: {
      ...createSessionWorkspaceProps(state, {
        draftScope: params.presentationId,
        presentation: params.presentation,
        openIntent: "navigate",
        draftContext: {
          sessionTitle: params.sessionTitle,
          paneLabel: params.paneLabel,
        },
        expanded: isPanelVisible("workspace"),
        presented: params.presented,
      }),
      collapsed: !isPanelVisible("workspace"),
      onToggleCollapsed: () => togglePanelSlot("workspace"),
      onToggleTerminal: state.terminalAvailable ? () => togglePanelSlot("terminal") : undefined,
      onToggleBrowser: state.browserPanelAvailable ? () => togglePanelSlot("browser") : undefined,
      onToggleDesktop: isDesktopPanelAvailable(params.gatewaySnapshot)
        ? () => togglePanelSlot("desktop")
        : undefined,
    },
  };
}
