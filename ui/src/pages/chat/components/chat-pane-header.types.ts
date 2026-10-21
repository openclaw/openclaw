import type { Element } from "solid-js";
import type { GatewaySessionRow, SessionBranch } from "../../../api/types.ts";
import type { GatewayStatusProps } from "../../../components/gateway-status.ts";
import type { PersonActivityRouting } from "../../../components/person-activity-link.ts";
import type { SessionPlacementPresentation } from "../../../components/session-placement-move-dialog.tsx";
import type { AgentIdentity } from "../../../lib/identity-avatar-view.ts";
import type { PresentationValue } from "../../../lib/presentation.ts";
import type { ChatMobilePeopleMentions } from "../chat-mobile-people-mentions.ts";
import type { ChatMobilePeople } from "../chat-mobile-people.ts";
import type { PaneHeaderPresence, PaneSubagentStop } from "../chat-pane-header-view.tsx";
import type { ChatDetailsViewProps } from "./chat-details.tsx";
import type { ChatDashboardMenu, ChatPaneLayoutMenuProps } from "./chat-header-panel-actions.tsx";
import type { ChatPanePlacement } from "./chat-pane-placement.tsx";
import type {
  ChatSessionSharingProps,
  PreparedChatSessionSharing,
} from "./chat-session-sharing-shared.tsx";
import type { ChatSessionVersionsMobileProps } from "./chat-session-versions-mobile.tsx";
import type { ContinueInTerminalDialogProps } from "./continue-in-terminal-dialog.tsx";

export type ChatPaneParentSession = {
  key: string;
  title: string;
};

export type ChatPaneHeaderAction = "reveal" | "copy-path" | "copy-branch";

export type ChatPaneHeaderProps = ChatPaneLayoutMenuProps & {
  onHeaderRef?: (element: HTMLElement) => void | (() => void);
  presented: PresentationValue;
  mergedChrome: boolean;
  navDrawerOpen?: boolean;
  gatewayStatus?: GatewayStatusProps | null;
  title: string;
  agent?: AgentIdentity & { name: string };
  titlePending?: boolean;
  session: GatewaySessionRow | undefined;
  incognito?: boolean;
  showOwnerChip?: boolean;
  ownerViewing?: boolean;
  personActivity?: PersonActivityRouting;
  catalog: boolean;
  catalogColor?: string;
  editing: boolean;
  renameValue: string;
  workspaceRoot: string | null;
  workspaceLabel: string | null;
  /** Gateway-resolved project icon for the chip; absent keeps the folder glyph. */
  workspaceIcon: {
    routeUrl: string;
    authTokens: readonly string[];
    authReady: boolean;
    connectionId?: string;
  } | null;
  parentSession: ChatPaneParentSession | null;
  branch: string | null;
  branches: SessionBranch[];
  branchSwitchDisabledReason: string | null;
  platform: string | null;
  canReveal: boolean;
  copiedAction: ChatPaneHeaderAction | null;
  renameDisabledReason?: string;
  runningSubagentCount?: number;
  dashboardWidgetMenu?: Parameters<typeof ChatDashboardMenu>[0]["widgetMenu"];
  setDashboardControls?: (action: Element | undefined) => void;
  panelActionDestinations?: { main: boolean; side: boolean; dashboard: boolean };
  /** The surrounding desktop frame supplies the Panels toggle. */
  externalPanelsToggle?: boolean;
  detailsControl?: ChatDetailsViewProps;
  onOpenDetails?: (source: HTMLElement) => void;
  conversationVisible?: boolean;
  onToggleConversation?: () => void;
  runAction?: Parameters<typeof PaneSubagentStop>[0];
  presence?: Parameters<typeof PaneHeaderPresence>[0];
  sharingControl?: ChatSessionSharingProps;
  mobileSharing?: PreparedChatSessionSharing;
  mobileVersions?: ChatSessionVersionsMobileProps;
  mobilePeople?: ChatMobilePeople;
  mobilePeopleMentions?: ChatMobilePeopleMentions;
  onOpenDashboard?: (source: HTMLElement) => void;
  publicAccessIndicator?: ChatSessionSharingProps;
  readMachineName?: () => Promise<string | undefined>;
  onMobilePlacementStop?: (machineName?: string) => Promise<void>;
  onMobilePlacementMove?: (presentation: SessionPlacementPresentation) => Promise<void>;
  placementControl?: Parameters<typeof ChatPanePlacement>[0];
  sessionMenuAction?: Omit<
    HTMLElementTagNameMap["openclaw-chat-header-session-menu"],
    keyof HTMLElement | "updateComplete" | "openMenu" | "readTrigger"
  >;
  onBeginRename: () => void;
  onRenameInput: (value: string) => void;
  onCommitRename: () => void;
  onCancelRename: () => void;
  onMenuOpenChange: (open: boolean) => void;
  onMenuAction: (action: ChatPaneHeaderAction) => void;
  onOpenParentSession: (sessionKey: string) => void;
  onOpenAgentSettings?: (agentId: string) => void;
  onBranchSelect: (leafEntryId: string) => void;
};

export type ChatPaneHeaderPresentation = {
  header: ChatPaneHeaderProps;
  continueInTerminal?: ContinueInTerminalDialogProps;
};
