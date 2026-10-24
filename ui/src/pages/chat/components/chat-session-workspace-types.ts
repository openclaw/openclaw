import type { GatewayBrowserClient, GatewayHelloOk } from "../../../api/gateway.ts";
import type { SessionWorkspaceListResult } from "../../../api/types.ts";
import type { PanelUnavailableReason } from "../../../app/panel-availability.ts";
import type { UiSettings } from "../../../app/settings.ts";
import type { SessionCapability, SessionScopeHost } from "../../../lib/sessions/index.ts";
import type {
  SessionWorkspaceFilter,
  SessionWorkspaceTreeState,
  SessionWorkspaceNavigation,
  SessionWorkspaceDirectory,
  SessionWorkspaceMobileNavigation,
  SessionWorkspacePreview,
  SidebarContent,
  SidebarSelection,
} from "./chat-sidebar-content-types.ts";

export type SessionWorkspaceArtifacts = {
  /** Completion of the owner's admitted read; presentation observes without issuing another RPC. */
  readResult?: Promise<void>;
  items: NonNullable<SessionWorkspaceListResult["artifacts"]>;
  /** At least one successful response; remains true through refresh/error. */
  resolved: boolean;
  /** Cached response is current; invalidation clears this without dropping items. */
  loaded: boolean;
  loading: boolean;
  error: string | null;
};

export type SessionWorkspaceState = {
  readResult?: Promise<void>;
  catalogNavigation?: SessionWorkspaceNavigation;
  pendingPreview?: { id: string; disposition: "pinned" | "preview" };
  mobileNavigation?: SessionWorkspaceMobileNavigation;
  tree?: SessionWorkspaceTreeState;
  directories?: Record<string, SessionWorkspaceDirectory>;
  artifacts?: SessionWorkspaceArtifacts;
  /** Native messageRole=assistant variant, never substituted for the Files catalog. */
  assistantArtifacts?: SessionWorkspaceArtifacts;

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
  browserPanelUnavailableReason?: PanelUnavailableReason | null;
  assistantAgentId?: string | null;
  agentsList?: SessionScopeHost["agentsList"];
  settings?: UiSettings;
  sessionWorkspaceState?: SessionWorkspaceState;
  sessionWorkspaceDraftScope?: string;
  sessionWorkspaceDraftContext?: { sessionTitle?: string; paneLabel?: string };
  sidebarContent: SidebarSelection | null;
  handleOpenSidebar: (content: SidebarSelection | null) => void;
};
