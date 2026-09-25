import type { ChatAccountSelection } from "../../../../packages/gateway-protocol/src/index.ts";
import type { SessionObserverDigest } from "../../../../packages/gateway-protocol/src/schema/sessions.js";
import type {
  AgentsListResult,
  ModelAuthStatusResult,
  ModelCatalogEntry,
  ModelCatalogResult,
  SessionsListResult,
} from "../../api/types.ts";
import type { ImageLightboxItem } from "../../components/image-lightbox.types.ts";
import type {
  ChatComposerMemoryFallback,
  ChatGuardianNotice,
  HumanMention,
} from "../../lib/chat/chat-types.ts";
import type { EmbedSandboxMode } from "../../lib/chat/tool-display.ts";
import type { PendingChatAbort } from "./chat-abort-request.ts";
import type { PullRequestRefreshHost } from "./chat-pull-request-refresh.ts";
import type { ChatRealtimeState } from "./chat-realtime.ts";
import type { ChatSendTimingEntry } from "./chat-send-ack.ts";
import type { ChatHost } from "./chat-send-contract.ts";
import type { ChatState } from "./chat-state-contract.ts";
import type { ChatProps } from "./chat-view.ts";
import type { BackgroundTasksHost } from "./components/chat-background-tasks.ts";
import type { SessionWorkspaceHost } from "./components/chat-session-workspace.ts";
import type { SidebarSelection } from "./components/chat-sidebar.ts";
import type { ChatExportResult } from "./export.ts";
import type { ChatInputHistoryKeyInput, ChatInputHistoryKeyResult } from "./input-history.ts";
import type { ChatMessageCache } from "./session-message-cache.ts";
import type { SidebarLayout } from "./sidebar-layout.ts";
import type {
  CompactionStatus,
  FallbackStatus,
  WaitingApprovalStatus,
} from "./tool-stream-contract.ts";

export type { ChatComposerMemoryFallback } from "../../lib/chat/chat-types.ts";

export type ChatPageHost = ChatHost &
  ChatState &
  ChatRealtimeState &
  PullRequestRefreshHost &
  SessionWorkspaceHost &
  BackgroundTasksHost & {
    reviewQueuedMessageEdit?: () => void;
    chatMetadataIsPresented?: () => boolean;
    password: string;
    onboarding: boolean;
    assistantName: string;
    assistantAvatar: string | null;
    assistantAvatarStatus: "none" | "local" | "remote" | "data" | null;
    assistantAvatarReason: string | null;
    assistantAvatarSource: string | null;
    assistantIdentityRequestVersion: number;
    userName: string | null;
    userAvatar: string | null;
    embedSandboxMode: EmbedSandboxMode;
    allowExternalEmbedUrls: boolean;
    automaticallyFetchFavicons: boolean;
    guardianNotices: ChatGuardianNotice[];
    chatComposerFallbackByScope: Record<string, ChatComposerMemoryFallback>;
    chatSendingScopeKey: string | null;
    chatMessagesBySession: ChatMessageCache;
    basePath: string;
    resourceBasePath: string;
    chatAvatarUrl: string | null;
    senderAgentAvatars?: ReadonlyMap<string, string | null>;
    chatAvatarSource: string | null;
    chatAvatarStatus: "none" | "local" | "remote" | "data" | null;
    chatAvatarReason: string | null;
    chatModelSwitchPromises: Record<string, Promise<boolean>>;
    chatModelPickerOpenSessionKey?: string | null;
    chatModelCatalog: ModelCatalogEntry[];
    chatModelCatalogInitialized?: boolean;
    chatModelCatalogError: string | null;
    chatModelCatalogRefreshFailed?: boolean;
    chatModelCatalogPendingProviders?: readonly string[];
    chatModelSelectionPolicy?: ModelCatalogResult["modelSelectionPolicy"];
    chatModelCatalogRetired?: boolean;
    chatAccountSelection?: ChatAccountSelection | null;
    modelAuthStatusRequestVersion: number;
    modelAuthStatusResult: ModelAuthStatusResult | null;
    modelAuthStatusError: string | null;
    sessionsResult: SessionsListResult | null;
    sessionsResultAgentId: string | null;
    sessionsError: string | null;
    sessionsArchivedFilter: "active" | "archived" | "all";
    selectedChatSessionArchived: boolean;
    selectedChatSessionIncognito: boolean;
    agentsList: AgentsListResult | null;
    agentsSelectedId: string | null;
    pendingAbort: PendingChatAbort | null;
    pendingSessionMessageReloadSessionKey: string | null;
    chatSubmitGuards: Set<string>;
    chatSendTimingsByRun: Map<string, ChatSendTimingEntry>;
    compactionStatus: CompactionStatus | null;
    fallbackStatus: FallbackStatus | null;
    observerDigest: SessionObserverDigest | null;
    knownAgentRunIds: Set<string>;
    waitingApprovalStatuses: Map<string, WaitingApprovalStatus>;
    waitingApprovalResolvedIds: Set<string>;
    chatRunStatus: ChatProps["runStatus"];
    chatModelsLoading: boolean;
    sessionsLoading: boolean;
    lastErrorCode: string | null;
    chatStreamRenderFrame: number | null;
    chatLastScrollHeight: number;
    sidebarLayout: SidebarLayout;
    sidebarContent: SidebarSelection | null;
    sidebarFocusPanelId: string;
    sidebarFocusVersion: number;
    updateSidebarActivePanel: (panelId: string) => void;
    imageLightbox: ImageLightboxItem | null;
    imageLightboxRequestVersion: number;
    querySelector: (selectors: string) => Element | null;
    resetToolStream: () => void;
    resetChatScroll: () => void;
    resetChatInputHistoryNavigation: () => void;
    scrollToBottom: (opts?: { smooth?: boolean }) => void;
    loadAssistantIdentity: () => Promise<void>;
    handleChatScroll: (event: Event) => void;
    handleChatDraftChange: (next: string, mentions?: readonly HumanMention[]) => void;
    handleChatInputHistoryKey: (input: ChatInputHistoryKeyInput) => ChatInputHistoryKeyResult;
    handleSendChat: (
      messageOverride?: string,
      options?: unknown,
      submissionAction?: Event,
    ) => Promise<boolean | void>;
    handleAbortChat: (options?: unknown) => Promise<void>;
    removeQueuedMessage: (id: string) => void;
    retryQueuedChatMessage: (id: string) => Promise<void>;
    steerQueuedChatMessage: (id: string) => Promise<void>;
    moveQueuedChatMessage: (id: string, targetId: string) => void;
    editQueuedChatMessage: (id: string) => void;
    updateQueuedChatMessageEdit: (draftText: string, mentions?: readonly HumanMention[]) => void;
    submitQueuedChatMessageEdit: () => void;
    cancelQueuedChatMessageEdit: () => void;
    handleCloseSidebar: (slot: "detail" | "workspace") => void;
    updateSidebarLayout: (
      layout: SidebarLayout,
      options?: {
        persist?: boolean;
        dashboardPresentation?: "personal";
        geometryOnly?: boolean;
        automaticResource?: "desktop" | "browser";
      },
    ) => void;
    beginImageOpen: () => number;
    handleOpenImage: (item: ImageLightboxItem, requestVersion?: number) => void;
    handleCloseImage: () => void;
    announceSessionSwitch?: (sessionKey: string, label: string) => void;
    createChatSession?: () => Promise<boolean>;
    confirmConversationReset?: () => Promise<boolean>;
    exportCurrentChat?: () => Promise<ChatExportResult> | ChatExportResult;
    refreshCurrentSessionTools?: () => Promise<void>;
    refreshCurrentChat?: () => Promise<void>;
    retireSessionCompanion?: (sessionKey: string, agentId?: string | null) => void;
  };
