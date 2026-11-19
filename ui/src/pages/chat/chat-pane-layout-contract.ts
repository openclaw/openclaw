import type { SessionObserverDigest } from "../../../../packages/gateway-protocol/src/index.js";
import type { GatewaySessionRow } from "../../api/types.ts";
import type { PaneDetailsActions } from "./chat-pane-header-layout.ts";
import type { createChatPaneRails } from "./chat-pane-rails.ts";
import type { ResolvedBoardView } from "./chat-pane-shared.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import type { ChatProps } from "./chat-view.tsx";
import type { SidebarLayout, SidebarSlotId } from "./sidebar-layout.ts";

export type ChatPaneLayoutRenderParams = {
  state: ChatPageHost;
  selectedSession: GatewaySessionRow | undefined;
  currentAgentId: string;
  board: ResolvedBoardView;
  sidebarLayout: SidebarLayout;
  sessionWorkspace: ReturnType<typeof createChatPaneRails>["sessionWorkspace"] &
    Pick<ChatProps, "onScrollPortRef">;
  chatProps: ChatProps;
  detailsActions: PaneDetailsActions;
  observerDigest: SessionObserverDigest | null;
  observerRunId: string | null;
  catalog: boolean;
  agentWorkspace: string | undefined;
  workspaceGit: boolean;
  openPanelSlot: (slot: SidebarSlotId) => void;
  closePanelSlot: (slot: SidebarSlotId) => void;
};
