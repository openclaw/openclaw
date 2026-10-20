import type { GatewayBrowserClient, GatewayHelloOk } from "../../../api/gateway.ts";
import type { SessionWorkspaceListResult } from "../../../api/types.ts";
import type { UiSettings } from "../../../app/settings.ts";
import type { SessionCapability, SessionScopeHost } from "../../../lib/sessions/index.ts";
import type { createSessionWorkspaceProps } from "./chat-session-workspace.ts";
import type {
  FileSidebarNavigation,
  SidebarContent,
  SidebarSelection,
} from "./chat-sidebar-content-types.ts";

export type SessionWorkspaceFilter = "all" | "changed" | "read" | "artifacts";

type SessionWorkspaceView = ReturnType<typeof createSessionWorkspaceProps>;
export type SessionWorkspaceProps = Omit<
  SessionWorkspaceView,
  "connectionEpoch" | "onDownloadFile" | "onOpenDiff"
> &
  Partial<Pick<SessionWorkspaceView, "connectionEpoch" | "onDownloadFile" | "onOpenDiff">>;

export type SessionWorkspacePreview = {
  id: string;
  label: string;
  content: SidebarSelection;
  canonicalKey?: string;
  requestIds?: string[];
  navigation?: FileSidebarNavigation;
  navigationOrder?: number;
};

export type SessionWorkspaceState = {
  navigationOrder?: number;
  previews: SessionWorkspacePreview[];
  activePreviewId: string | null;
  filter: SessionWorkspaceFilter;
  activeId: string | null;
  agentId: string;
  browserPath: string;
  browserSearch: string;
  browserSearchTimer: ReturnType<typeof globalThis.setTimeout> | null;
  connectionEpoch: number;
  diffContent?: SidebarContent;
  error: string | null;
  errorOwner?: object;
  list: SessionWorkspaceListResult | null;
  loading: boolean;
  pendingReload: boolean;
  sessionKey: string;
};

// Re-renders must preserve the document identity or the mounted diff panel
// treats its loader as new and requests sessions.diff again.
export type SessionWorkspaceHost = {
  sessionKey: string;
  sessions: SessionCapability;
  client: GatewayBrowserClient | null;
  connected: boolean;
  connectionEpoch: number;
  hello: GatewayHelloOk | null;
  resourceBasePath?: string;
  terminalAvailable?: boolean;
  browserPanelAvailable?: boolean;
  assistantAgentId?: string | null;
  agentsList?: SessionScopeHost["agentsList"];
  settings?: UiSettings;
  sessionWorkspaceState?: SessionWorkspaceState;
  sessionWorkspaceDraftScope?: string;
  sessionWorkspaceDraftContext?: { sessionTitle?: string; paneLabel?: string };
  sidebarContent: SidebarSelection | null;
  handleOpenSidebar: (content: SidebarSelection | null) => void;
};
