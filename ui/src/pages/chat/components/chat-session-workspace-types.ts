import type { GatewayBrowserClient, GatewayHelloOk } from "../../../api/gateway.ts";
import type { SessionWorkspaceListResult } from "../../../api/types.ts";
import type { PanelUnavailableReason } from "../../../app/panel-availability.ts";
import type { UiSettings } from "../../../app/settings.ts";
import type { SessionCapability, SessionScopeHost } from "../../../lib/sessions/index.ts";
import type {
  FileSidebarNavigation,
  FileReaderDraftState,
  SidebarContent,
  SidebarSelection,
} from "./chat-sidebar-content-types.ts";

export type SessionWorkspaceFilter = "all" | "changed" | "read" | "artifacts";

export type SessionWorkspaceTreeState = {
  expandedPaths: string[];
  searchOpen: boolean;
  sessionExpanded: boolean;
  treeVisible: boolean;
  treeScroll: number;
  sessionScroll: number;
};

/** Snapshot handed to the tabs owner; it never contains a reader or a draft. */
export type SessionWorkspaceNavigation = SessionWorkspaceTreeState & {
  browserPath: string;
  browserSearch: string;
  filter: SessionWorkspaceFilter;
};

export type SessionWorkspaceDirectory = {
  browser?: SessionWorkspaceListResult["browser"];
  loading: boolean;
  error: string | null;
};

export type SessionWorkspaceArtifacts = {
  items: NonNullable<SessionWorkspaceListResult["artifacts"]>;
  /** At least one successful response; remains true through refresh/error. */
  resolved: boolean;
  /** Cached response is current; invalidation clears this without dropping items. */
  loaded: boolean;
  loading: boolean;
  error: string | null;
};

export type SessionWorkspaceMobileGroupKind = "changed" | "read" | "artifacts" | "workspace";
export type SessionWorkspaceMobileNavigation = {
  expandedGroups: Record<SessionWorkspaceMobileGroupKind, boolean>;
  scrollTop: number;
  locations: Record<string, { search: string; filter: SessionWorkspaceFilter; scrollTop: number }>;
};

export type SessionWorkspacePreview = {
  id: string;
  label: string;
  content: SidebarSelection;
  /** Only an explicit desktop preview is replaceable; retained tabs stay pinned. */
  pinned?: boolean;
  catalogNavigation?: SessionWorkspaceNavigation;
  catalogVisible?: boolean;
  readerDraft?: FileReaderDraftState;
  canonicalKey?: string;
  requestIds?: string[];
  navigation?: FileSidebarNavigation;
  navigationOrder?: number;
};

export type SessionWorkspaceState = {
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
