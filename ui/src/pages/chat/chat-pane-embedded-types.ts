import type { ControlUiFocusBuildTarget } from "@openclaw/session-url-contract";
import type { SessionObserverDigest } from "../../../../packages/gateway-protocol/src/schema/sessions.js";
import type { ControlUiSessionPullRequest } from "../../../../src/gateway/control-ui-contract.js";
import type { ControlUiPanel } from "../../../../src/plugin-sdk/control-ui.js";
import type { ControlUiLinkReaderDescriptor } from "../../../../src/shared/control-ui-link-reader.js";
import type {
  BrowserTabSelection,
  BrowserTabTarget,
} from "../../components/browser/browser-target.ts";
import type { HostDesktopRuntimeConfig } from "../../components/desktop/host-desktop-setup.ts";
import type { ChatAttachment } from "../../lib/chat/chat-types.ts";
import type { PresentationValue } from "../../lib/presentation.ts";
import type { ControlUiRegistration } from "../../plugins/control-ui-capability.ts";
import type { PaneSessionChangeOptions } from "./chat-pane-shared.ts";
import type { ChatBoardPanel } from "./chat-pane-surfaces.tsx";
import type {
  ChatSessionCompanionThread,
  ChatSessionCompanionTurn,
} from "./chat-session-companion.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import type { ChatProps } from "./chat-view-frame.ts";
import type { ChatModelControlsProps } from "./components/chat-model-controls.tsx";
import type { SessionWorkspaceState } from "./components/chat-session-workspace-types.ts";
import type { SidebarSelection } from "./components/chat-sidebar-content-types.ts";
import type { SessionWorkspaceProps } from "./components/chat-sidebar-view-types.ts";
import type { SessionDiscussionPanelConfig } from "./components/session-discussion-panel.tsx";
import type { SidebarSlotId } from "./sidebar-layout-types.ts";

export type ChatDetailSlotProps = {
  chat: ChatProps;
  content: SidebarSelection;
  host: ChatPageHost;
};

export type SidebarPanelDefinitionParams = {
  panePresentation?: PresentationValue;
  state: ChatPageHost;
  paneId: string;
  panePresentationId: string;
  subagentsInputRegion: "page" | "dock";
  subagentsPresented: PresentationValue;
  processesPresented?: PresentationValue;
  subagentsAvailable: boolean;
  subagentsShowRequest?: () => string | null | undefined;
  onSubagentSessionSelect: (
    sessionKey: string,
    options?: PaneSessionChangeOptions,
  ) => boolean | void;
  themeMode: "dark" | "light";
  agentId: string | null;
  browserPresented: PresentationValue;
  browserTabsInHeader: boolean;
  linkReaders?: readonly ControlUiLinkReaderDescriptor[];
  linkReaderPresented?: PresentationValue;
  linkReaderTabsInHeader?: boolean;
  onCloseLinkReader?: () => void;
  terminalTabsInHeader: boolean;
  onCloseTerminal?: () => void;
  browserRefreshOnPresentation: boolean;
  preferredBrowserTab?: BrowserTabSelection;
  sessionBrowserTabs?: BrowserTabTarget[];
  desktopPresented: PresentationValue;
  desktopRefreshOnPresentation: boolean;
  desktopAvailable: boolean;
  desktopSource: string | null;
  desktopRuntimeConfig: HostDesktopRuntimeConfig | null;
  desktopFocusHref: string;
  portalPresented?: PresentationValue;
  onDesktopFocusTargetChange: (
    target: Extract<ControlUiFocusBuildTarget, { kind: "desktop" }>,
  ) => void;
  dashboard: Parameters<typeof ChatBoardPanel>[0] | null;
  workspace: SessionWorkspaceProps | undefined;
  detail: Omit<ChatDetailSlotProps, "content">;
  digest: SessionObserverDigest | null;
  activeRunId: string | null;
  pullRequests: ControlUiSessionPullRequest[];
  companion: ChatSessionCompanionThread;
  companionModelControls?: ChatModelControlsProps;
  companionPresented: PresentationValue;
  companionFocusRequest: (() => boolean) | undefined;
  onCompanionSubmit: (question: string | ChatSessionCompanionTurn) => void;
  onCompanionDraftChange: (draft: string) => void;
  onCompanionAttachmentsChange?: (attachments: ChatAttachment[]) => boolean | void;
  connected: boolean;
  onClearCompanion: () => void;
  onCreateClaw?: () => void;
  discussion: SessionDiscussionPanelConfig | null;
  discussionAvailable: boolean;
  discussionOpenUrl: string | null;
  discussionSourceGeneration: number;
  pluginPanels: ControlUiRegistration<ControlUiPanel>[];
  isPluginPanelPresented: (slot: SidebarSlotId) => PresentationValue;
};

/** The retained panel chooses its native view from the existing sidebar slot. */
export type SidebarPanelData = SidebarPanelDefinitionParams & {
  workspaceState: SessionWorkspaceState;
  detailContent: SidebarSelection | null;
  detailPresentation: PresentationValue;
};
