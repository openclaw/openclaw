import { consume } from "@lit/context";
import { html, LitElement, type TemplateResult } from "lit";
import { property } from "lit/decorators.js";
import type { GatewayBrowserClient, GatewayEventFrame } from "../../api/gateway.ts";
import type { AgentsListResult, ModelCatalogEntry, SessionsListResult } from "../../api/types.ts";
import {
  fetchAssistantIdentity,
  loadLocalAssistantIdentity,
} from "../../app/assistant-identity.ts";
import {
  applicationContext,
  type ApplicationContext,
  type ApplicationGatewaySnapshot,
} from "../../app/context.ts";
import { resolveControlUiAuthToken } from "../../app/control-ui-auth.ts";
import {
  loadLocalUserIdentity,
  loadSettings,
  saveSettings,
  type UiSettings,
} from "../../app/settings.ts";
import {
  COMMAND_PALETTE_TARGET_EVENT,
  type CommandPaletteTargetDetail,
} from "../../components/command-palette.ts";
import "../../components/tooltip.ts";
import { refreshVisibleToolsEffectiveForCurrentSession } from "../../lib/agents/tools-effective.ts";
import type { AssistantIdentity } from "../../lib/assistant-identity.ts";
import { isRenderableControlUiAvatarUrl } from "../../lib/avatar.ts";
import type { ChatAttachment, ChatQueueItem } from "../../lib/chat/chat-types.ts";
import type { EmbedSandboxMode } from "../../lib/chat/tool-display.ts";
import { isGatewayMethodAdvertised } from "../../lib/gateway-methods.ts";
import { resolveSessionDisplayName } from "../../lib/session-display.ts";
import {
  resolveSessionKey,
  searchForSession,
  scopedAgentParamsForSession,
  type SessionCapability,
} from "../../lib/sessions/index.ts";
import {
  buildAgentMainSessionKey,
  normalizeAgentId,
  parseAgentSessionKey,
  resolveAgentIdFromSessionKey,
  resolveUiSelectedGlobalAgentId,
} from "../../lib/sessions/session-key.ts";
import {
  handleAgentEvent,
  handleSessionOperationEvent,
  resetToolStream,
  type CompactionStatus,
  type FallbackStatus,
  type ToolStreamEntry,
} from "../../ui/app-tool-stream.ts";
import { applyModelCatalogResult, loadModels } from "../../ui/controllers/models.ts";
import { refreshChatAvatar } from "./chat-avatar.ts";
import { applyRemoteSlashCommandsResult, refreshSlashCommands } from "./chat-commands.ts";
import {
  handleChatGatewayEvent,
  handleChatSideResultGatewayEvent,
  loadChatHistory,
  syncSelectedSessionMessageSubscription,
  type ChatEventPayload,
  type ChatMetadataResult,
  type ChatState,
} from "./chat-gateway.ts";
import {
  flushChatQueueAfterIdleSessionReconciliation,
  handleAbortChat,
  handleSendChat,
  hasAbortableSessionRun,
  markQueuedChatSendsWaitingForReconnect,
  recordChatSendServerTiming,
  refreshChat,
  removeQueuedMessage,
  retryReconnectableQueuedChatSends,
  retryQueuedChatMessage,
  steerQueuedChatMessage,
  type ChatHost,
} from "./chat-send.ts";
import {
  clearChatHistory,
  refreshCurrentChatSessionList,
  switchChatFastMode,
  switchChatModel,
  switchChatThinkingLevel,
} from "./chat-session.ts";
import { renderChatControls } from "./components/chat-controls.ts";
import type { SidebarContent } from "./components/chat-sidebar.ts";
import {
  ChatComposerPersistenceController,
  persistChatComposerState,
  restoreChatComposerState,
} from "./composer-persistence.ts";
import {
  handleChatDraftChange,
  handleChatInputHistoryKey,
  resetChatInputHistoryNavigation,
  type ChatInputHistoryKeyInput,
  type ChatInputHistoryKeyResult,
} from "./input-history.ts";
import {
  createRealtimeTalkConversationState,
  updateRealtimeTalkConversation,
  type RealtimeTalkConversationEntry,
  type RealtimeTalkConversationState,
} from "./realtime-talk-conversation.ts";
import {
  RealtimeTalkSession,
  type RealtimeTalkLaunchOptions,
  type RealtimeTalkStatus,
} from "./realtime-talk.ts";
import { reconcileChatRunLifecycle } from "./run-lifecycle.ts";
import { scheduleChatScroll, handleChatScroll, resetChatScroll } from "./scroll.ts";
import {
  cacheChatMessages,
  clearChatMessagesFromCache,
  readChatMessagesFromCache,
} from "./session-message-cache.ts";
import { createSessionWorkspaceProps, type SessionWorkspaceHost } from "./session-workspace.ts";
import { renderChat, resetChatViewState, type ChatProps } from "./view.ts";

type ChatRouteData = {
  sessionKey: string;
  draft?: string;
};

type ChatPageContext = ApplicationContext;

const CHAT_OPEN_DETAILS_SELECTOR =
  ".chat-controls__inline-select[open], .agent-chat__talk-select[open], .agent-chat__talk-options-advanced[open]";

type ChatPageElement = {
  querySelector: (selectors: string) => Element | null;
  readonly updateComplete: Promise<unknown>;
};

const NEW_SESSION_ACTIVE_RUN_MESSAGE =
  "Start a new session after the active run or queued messages finish.";
const NEW_SESSION_LIST_LOADING_MESSAGE =
  "Session list is still refreshing. Try New Chat again in a moment.";
const NEW_SESSION_CREATE_FAILED_MESSAGE =
  "New Chat could not create a new session. Try again in a moment.";

type ChatPageHost = ChatHost &
  ChatState &
  SessionWorkspaceHost & {
    sessions: SessionCapability;
    settings: UiSettings;
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
    localMediaPreviewRoots: string[];
    embedSandboxMode: EmbedSandboxMode;
    allowExternalEmbedUrls: boolean;
    chatMessageMaxWidth: string | null;
    chatToolMessages: Record<string, unknown>[];
    chatAttachments: ChatAttachment[];
    chatQueue: ChatQueueItem[];
    chatQueueBySession: Record<string, ChatQueueItem[]>;
    chatMessagesBySession: Map<string, unknown[]>;
    chatSideResultTerminalRuns: Set<string>;
    chatModelSwitchPromises: Record<string, Promise<boolean>>;
    chatModelCatalog: ModelCatalogEntry[];
    sessionsResult: SessionsListResult | null;
    sessionsError: string | null;
    sessionsShowArchived: boolean;
    agentsList: AgentsListResult | null;
    agentsSelectedId: string | null;
    refreshSessionsAfterChat: Map<string, { sessionKey: string; agentId?: string }>;
    pendingAbort: { runId?: string | null; sessionKey: string; agentId?: string } | null;
    chatSubmitGuards: Map<string, Promise<void>>;
    chatSendTimingsByRun: Map<string, unknown>;
    chatStreamSegments: Array<{ text: string; ts: number }>;
    toolStreamById: Map<string, ToolStreamEntry>;
    toolStreamOrder: string[];
    toolStreamSyncTimer: number | null;
    activityEntries: unknown[];
    compactionStatus: CompactionStatus | null;
    fallbackStatus: FallbackStatus | null;
    chatRunStatus: ChatProps["runStatus"];
    chatNewMessagesBelow: boolean;
    chatManualRefreshInFlight: boolean;
    chatMobileControlsOpen: boolean;
    chatMobileControlsTrigger: HTMLElement | null;
    sessionsHideCron: boolean;
    chatLocalInputHistoryBySession: Record<string, Array<{ text: string; ts: number }>>;
    chatInputHistorySessionKey: string | null;
    chatInputHistoryItems: string[] | null;
    chatInputHistoryIndex: number;
    chatDraftBeforeHistory: string | null;
    chatScrollFrame: number | null;
    chatScrollTimeout: number | null;
    chatLastScrollTop: number;
    chatHasAutoScrolled: boolean;
    chatUserNearBottom: boolean;
    chatFollowLocked: boolean;
    chatHeaderControlsHidden: boolean;
    chatIsProgrammaticScroll: boolean;
    chatProgrammaticScrollTarget: number;
    sidebarOpen: boolean;
    sidebarContent: SidebarContent | null;
    splitRatio: number;
    querySelector: (selectors: string) => Element | null;
    updateComplete: Promise<unknown>;
    realtimeTalkActive: boolean;
    realtimeTalkStatus: RealtimeTalkStatus;
    realtimeTalkDetail: string | null;
    realtimeTalkTranscript: string | null;
    realtimeTalkConversation: RealtimeTalkConversationEntry[];
    realtimeTalkOptionsOpen: boolean;
    realtimeTalkCatalogProviders: ChatProps["realtimeTalkCatalogProviders"];
    realtimeTalkOptions: NonNullable<ChatProps["realtimeTalkOptions"]>;
    realtimeTalkSession: RealtimeTalkSession | null;
    realtimeTalkConversationState: RealtimeTalkConversationState;
    requestUpdate: () => void;
    onModelChanged: () => Promise<void> | undefined;
    resetToolStream: () => void;
    resetChatScroll: () => void;
    scrollToBottom: (opts?: { smooth?: boolean }) => void;
    setChatMobileControlsOpen: (
      open: boolean,
      options?: { trigger?: HTMLElement | null; restoreFocus?: boolean },
    ) => void;
    updateRealtimeTalkOptions: (
      next: Partial<NonNullable<ChatProps["realtimeTalkOptions"]>>,
    ) => void;
    resetRealtimeTalkConversation: () => void;
    loadAssistantIdentity: () => Promise<void>;
    applySettings: (next: UiSettings) => void;
    handleChatScroll: (event: Event) => void;
    handleChatDraftChange: (next: string) => void;
    handleChatInputHistoryKey: (input: ChatInputHistoryKeyInput) => ChatInputHistoryKeyResult;
    handleSendChat: (messageOverride?: string, options?: unknown) => Promise<void>;
    handleAbortChat: (options?: unknown) => Promise<void>;
    removeQueuedMessage: (id: string) => void;
    retryQueuedChatMessage: (id: string) => Promise<void>;
    steerQueuedChatMessage: (id: string) => Promise<void>;
    handleOpenSidebar: (content: Parameters<SessionWorkspaceHost["handleOpenSidebar"]>[0]) => void;
    handleCloseSidebar: () => void;
    handleSplitRatioChange: (ratio: number) => void;
    toggleRealtimeTalk: () => Promise<void>;
    fetchRealtimeTalkCatalog: () => Promise<void>;
    announceSessionSwitch?: (sessionKey: string, label: string) => void;
  };

function canCreateChatSession(
  state: Pick<
    ChatPageHost,
    "chatLoading" | "chatSending" | "chatRunId" | "chatStream" | "chatQueue"
  >,
) {
  return (
    !state.chatLoading &&
    !state.chatSending &&
    !state.chatRunId &&
    state.chatStream === null &&
    state.chatQueue.length === 0
  );
}

async function handleChatManualRefresh(state: ChatPageHost): Promise<void> {
  state.chatManualRefreshInFlight = true;
  state.chatNewMessagesBelow = false;
  await state.updateComplete;
  state.resetToolStream();
  try {
    await refreshPageChat(state, { awaitHistory: true, scheduleScroll: false });
    state.scrollToBottom({ smooth: true });
  } finally {
    requestAnimationFrame(() => {
      state.chatManualRefreshInFlight = false;
      state.chatNewMessagesBelow = false;
      state.requestUpdate();
    });
  }
}

function resolveAssistantAttachmentAuthToken(state: ChatPageHost) {
  return resolveControlUiAuthToken(state);
}

function dismissChatError(state: ChatPageHost) {
  state.lastError = null;
  state.lastErrorCode = null;
  state.chatError = null;
}

function dismissRealtimeTalkError(state: ChatPageHost) {
  if (state.realtimeTalkStatus !== "error") {
    return;
  }
  state.realtimeTalkSession?.stop();
  state.realtimeTalkSession = null;
  state.realtimeTalkActive = false;
  state.realtimeTalkStatus = "idle";
  state.realtimeTalkDetail = null;
  state.realtimeTalkTranscript = null;
  state.resetRealtimeTalkConversation();
}

function saveChatQueueForSession(state: ChatPageHost, sessionKey: string) {
  const queueBySession = state.chatQueueBySession;
  if (state.chatQueue.length > 0) {
    state.chatQueueBySession = {
      ...queueBySession,
      [sessionKey]: [...state.chatQueue],
    };
    return;
  }
  if (!Object.hasOwn(queueBySession, sessionKey)) {
    return;
  }
  const nextQueueBySession = { ...queueBySession };
  delete nextQueueBySession[sessionKey];
  state.chatQueueBySession = nextQueueBySession;
}

function restoreChatQueueForSession(state: ChatPageHost, sessionKey: string): ChatQueueItem[] {
  return [...(state.chatQueueBySession[sessionKey] ?? [])];
}

function saveChatMessagesForSession(state: ChatPageHost, sessionKey: string) {
  cacheChatMessages(state.chatMessagesBySession, state, { sessionKey }, state.chatMessages);
}

function restoreChatMessagesForSession(state: ChatPageHost, sessionKey: string): unknown[] {
  return readChatMessagesFromCache(state.chatMessagesBySession, state, { sessionKey });
}

function saveRouteSessionSettings(state: ChatPageHost, sessionKey: string) {
  if (
    state.settings.sessionKey === sessionKey &&
    state.settings.lastActiveSessionKey === sessionKey
  ) {
    return;
  }
  state.settings = {
    ...state.settings,
    sessionKey,
    lastActiveSessionKey: sessionKey,
  };
  saveSettings(state.settings);
}

function resetChatStateForRouteSession(state: ChatPageHost, sessionKey: string) {
  const previousSessionKey = state.sessionKey;
  persistChatComposerState(state, previousSessionKey);
  saveChatQueueForSession(state, previousSessionKey);
  saveChatMessagesForSession(state, previousSessionKey);
  state.sessionKey = sessionKey;
  state.currentSessionId = null;
  state.reconnectResumeSessionId = null;
  state.chatMessage = "";
  state.chatAttachments = [];
  state.chatReplyTarget = null;
  state.chatMessages = restoreChatMessagesForSession(state, sessionKey);
  state.chatToolMessages = [];
  state.activityEntries = [];
  state.activityExpandedIds = new Set();
  state.activityAtBottom = true;
  state.chatStreamSegments = [];
  state.chatThinkingLevel = null;
  state.chatVerboseLevel = null;
  state.chatStream = null;
  state.chatSideResult = null;
  state.lastError = null;
  state.chatError = null;
  state.chatAvatarUrl = null;
  state.chatAvatarSource = null;
  state.chatAvatarStatus = null;
  state.chatAvatarReason = null;
  state.realtimeTalkTranscript = null;
  state.resetRealtimeTalkConversation();
  state.chatQueue = restoreChatQueueForSession(state, sessionKey);
  restoreChatComposerState(state);
  state.resetChatInputHistoryNavigation();
  state.chatStreamStartedAt = null;
  reconcileChatRunLifecycle(state, {
    clearLocalRun: true,
    clearChatStream: true,
    clearToolStream: true,
    clearSideResultTerminalRuns: true,
    clearRunStatus: true,
  });
  state.resetChatScroll();
  saveRouteSessionSettings(state, sessionKey);
}

async function refreshRouteSessionOptions(state: ChatPageHost) {
  await refreshCurrentChatSessionList(state);
}

function resolveChatAgentId(
  state: Pick<ChatPageHost, "sessionKey" | "agentsList" | "assistantAgentId" | "hello">,
) {
  return normalizeAgentId(
    parseAgentSessionKey(state.sessionKey)?.agentId ??
      scopedAgentParamsForSession(state, state.sessionKey).agentId ??
      resolveUiSelectedGlobalAgentId(state),
  );
}

function resolveChatAvatarUrl(
  state: Pick<
    ChatPageHost,
    | "sessionKey"
    | "agentsList"
    | "assistantAgentId"
    | "hello"
    | "assistantAvatar"
    | "assistantAvatarStatus"
    | "assistantAvatarReason"
    | "chatAvatarUrl"
    | "chatAvatarStatus"
    | "chatAvatarReason"
  >,
): string | null {
  const agentId = resolveChatAgentId(state);
  const localAvatar = loadLocalAssistantIdentity({ agentId }).avatar;
  if (localAvatar) {
    return localAvatar;
  }
  const avatarMissing =
    (state.chatAvatarStatus ?? state.assistantAvatarStatus) === "none" &&
    (state.chatAvatarReason ?? state.assistantAvatarReason) === "missing";
  const assistantAvatar = state.assistantAvatar;
  if (!avatarMissing && assistantAvatar && isRenderableControlUiAvatarUrl(assistantAvatar)) {
    if (state.assistantAgentId === agentId) {
      return assistantAvatar;
    }
  }
  if (state.chatAvatarUrl) {
    return state.chatAvatarUrl;
  }
  const identity = state.agentsList?.agents?.find((agent) => agent.id === agentId)?.identity;
  const avatar = identity?.avatarUrl ?? identity?.avatar;
  return typeof avatar === "string" && isRenderableControlUiAvatarUrl(avatar) ? avatar : null;
}

type ChatMetadataApplyResult = {
  commands: boolean;
  models: boolean;
};

type ChatRefreshOptions = {
  scheduleScroll?: boolean;
  awaitHistory?: boolean;
  startup?: boolean;
};

function scheduleChatMetadataRefresh(callback: () => void) {
  const requestIdleCallback =
    typeof globalThis.requestIdleCallback === "function" ? globalThis.requestIdleCallback : null;
  if (requestIdleCallback) {
    requestIdleCallback(callback, { timeout: 750 });
    return;
  }
  globalThis.setTimeout(callback, 50);
}

async function refreshChatModels(host: ChatPageHost) {
  if (!host.client || !host.connected) {
    host.chatModelsLoading = false;
    host.chatModelCatalog = [];
    return;
  }
  host.chatModelsLoading = true;
  try {
    host.chatModelCatalog = await loadModels(host.client);
  } finally {
    host.chatModelsLoading = false;
  }
}

async function refreshChatCommands(host: ChatPageHost) {
  await refreshSlashCommands({
    client: host.client,
    agentId: resolveChatAgentId(host),
  });
}

function applyChatMetadataResult(
  host: ChatPageHost,
  client: GatewayBrowserClient,
  agentId: string | null | undefined,
  result: ChatMetadataResult,
): ChatMetadataApplyResult {
  const models = applyModelCatalogResult(result.models);
  if (models) {
    host.chatModelCatalog = models;
  }
  const commandsApplied = applyRemoteSlashCommandsResult({
    client,
    agentId,
    result,
  });
  return { commands: commandsApplied, models: Boolean(models) };
}

async function refreshChatMetadata(host: ChatPageHost) {
  if (!host.client || !host.connected) {
    host.chatModelsLoading = false;
    host.chatModelCatalog = [];
    return;
  }
  const client = host.client;
  const sessionKey = host.sessionKey;
  const agentId = resolveChatAgentId(host);
  if (isGatewayMethodAdvertised(host as unknown as ChatState, "chat.metadata") === false) {
    await Promise.allSettled([refreshChatModels(host), refreshChatCommands(host)]);
    return;
  }

  host.chatModelsLoading = true;
  try {
    const result = await client.request<ChatMetadataResult>(
      "chat.metadata",
      agentId ? { agentId } : {},
    );
    if (
      host.client !== client ||
      !host.connected ||
      host.sessionKey !== sessionKey ||
      resolveChatAgentId(host) !== agentId
    ) {
      return;
    }
    const metadataApplied = applyChatMetadataResult(host, client, agentId, result);
    if (!metadataApplied.models || !metadataApplied.commands) {
      await Promise.allSettled([
        ...(metadataApplied.models ? [] : [refreshChatModels(host)]),
        ...(metadataApplied.commands ? [] : [refreshChatCommands(host)]),
      ]);
    }
  } catch {
    await Promise.allSettled([refreshChatModels(host), refreshChatCommands(host)]);
  } finally {
    if (host.client === client) {
      host.chatModelsLoading = false;
    }
  }
}

function refreshPageChat(host: ChatPageHost, opts?: ChatRefreshOptions) {
  let resolveStartupMetadata: (result: ChatMetadataApplyResult) => void = () => {};
  const startupMetadataApplied =
    opts?.startup && host.client && host.connected
      ? new Promise<ChatMetadataApplyResult>((resolve) => {
          resolveStartupMetadata = resolve;
        })
      : Promise.resolve({ commands: false, models: false });

  const refresh = refreshChat(host, {
    ...opts,
    onStartupMetadata: ({ client, agentId, metadata }) => {
      const applied = metadata
        ? applyChatMetadataResult(host, client, agentId, metadata)
        : { commands: false, models: false };
      resolveStartupMetadata(applied);
    },
  });

  const refreshedSessionKey = host.sessionKey;
  scheduleChatMetadataRefresh(() => {
    if (host.sessionKey !== refreshedSessionKey || !host.connected) {
      return;
    }
    void startupMetadataApplied
      .catch(() => ({ commands: false, models: false }))
      .then((metadataApplied) => {
        const metadataRefresh =
          opts?.startup && (metadataApplied.commands || metadataApplied.models)
            ? metadataApplied.models
              ? Promise.allSettled([])
              : Promise.allSettled([refreshChatModels(host)])
            : Promise.allSettled([refreshChatMetadata(host)]);
        return Promise.allSettled([refreshChatAvatar(host), metadataRefresh]);
      })
      .finally(() => host.requestUpdate?.());
  });
  return refresh;
}

async function loadPageAssistantIdentity(
  state: ChatPageHost,
  opts?: { sessionKey?: string; expectedSessionKey?: string },
) {
  if (!state.client || !state.connected) {
    return;
  }
  const client = state.client;
  const sessionKey = opts?.sessionKey?.trim() || state.sessionKey.trim();
  const expectedSessionKey = opts?.expectedSessionKey?.trim() || sessionKey;
  const requestVersion = ++state.assistantIdentityRequestVersion;
  try {
    const identity = await fetchAssistantIdentity(client, sessionKey);
    if (
      state.client !== client ||
      !state.connected ||
      state.assistantIdentityRequestVersion !== requestVersion ||
      state.sessionKey.trim() !== expectedSessionKey ||
      !identity
    ) {
      return;
    }
    state.assistantName = identity.name;
    state.assistantAvatar = identity.avatar;
    state.assistantAvatarSource = identity.avatarSource ?? null;
    state.assistantAvatarStatus = identity.avatarStatus ?? null;
    state.assistantAvatarReason = identity.avatarReason ?? null;
    state.assistantAgentId = identity.agentId ?? null;
    state.requestUpdate?.();
  } catch {
    // Keep the last known identity when the Gateway cannot answer.
  }
}

function createPageState(
  context: ChatPageContext,
  requestUpdate: () => void,
  page: ChatPageElement,
): ChatPageHost {
  const settings = loadSettings();
  const identity = loadLocalUserIdentity();
  const appConfig = context.config.current;
  const state = {
    sessions: context.sessions,
    settings,
    password: "",
    onboarding: false,
    assistantName: context.assistantName,
    assistantAvatar: null,
    assistantAvatarStatus: null,
    assistantAvatarReason: null,
    assistantAvatarSource: null,
    assistantIdentityRequestVersion: 0,
    userName: identity.name,
    userAvatar: identity.avatar,
    localMediaPreviewRoots: appConfig.localMediaPreviewRoots,
    embedSandboxMode: appConfig.embedSandboxMode,
    allowExternalEmbedUrls: appConfig.allowExternalEmbedUrls,
    chatMessageMaxWidth: appConfig.chatMessageMaxWidth,
    client: null,
    connected: false,
    hello: null,
    assistantAgentId: context.agentSelection.state.selectedId,
    sessionKey: settings.sessionKey,
    chatLoading: false,
    chatSending: false,
    chatMessage: "",
    chatMessages: [] as unknown[],
    chatToolMessages: [] as Record<string, unknown>[],
    chatThinkingLevel: null,
    chatVerboseLevel: null,
    chatAttachments: [] as ChatAttachment[],
    chatRunId: null,
    chatStream: null,
    chatStreamStartedAt: null,
    lastError: null,
    chatError: null,
    agentsError: null,
    chatStreamSegments: [] as Array<{ text: string; ts: number }>,
    chatSideResult: null,
    chatSideResultTerminalRuns: new Set<string>(),
    chatRunStatus: null,
    compactionStatus: null,
    fallbackStatus: null,
    chatAvatarUrl: null,
    chatAvatarStatus: null,
    chatAvatarReason: null,
    chatModelSwitchPromises: {} as Record<string, Promise<boolean>>,
    chatModelsLoading: false,
    chatModelCatalog: [] as ModelCatalogEntry[],
    sessionsResult: null,
    sessionsLoading: false,
    sessionsError: null,
    sessionsShowArchived: false,
    agentsList: null,
    agentsSelectedId: null,
    refreshSessionsAfterChat: new Map<string, { sessionKey: string; agentId?: string }>(),
    pendingAbort: null,
    chatSubmitGuards: new Map<string, Promise<void>>(),
    chatSendTimingsByRun: new Map<string, unknown>(),
    chatQueue: [] as ChatQueueItem[],
    chatQueueBySession: {} as Record<string, ChatQueueItem[]>,
    chatMessagesBySession: new Map<string, unknown[]>(),
    eventLogBuffer: [] as unknown[],
    eventLog: [] as unknown[],
    tab: "chat",
    basePath: context.basePath,
    chatNewMessagesBelow: false,
    chatManualRefreshInFlight: false,
    chatMobileControlsOpen: false,
    chatMobileControlsTrigger: null,
    sessionsHideCron: true,
    chatLocalInputHistoryBySession: {} as Record<string, Array<{ text: string; ts: number }>>,
    chatInputHistorySessionKey: null,
    chatInputHistoryItems: null,
    chatInputHistoryIndex: -1,
    chatDraftBeforeHistory: null,
    chatScrollFrame: null,
    chatScrollTimeout: null,
    chatLastScrollTop: 0,
    chatHasAutoScrolled: false,
    chatUserNearBottom: true,
    chatFollowLocked: false,
    chatHeaderControlsHidden: false,
    chatIsProgrammaticScroll: false,
    chatProgrammaticScrollTarget: 0,
    sidebarOpen: false,
    sidebarContent: null,
    splitRatio: settings.splitRatio,
    toolStreamById: new Map<string, ToolStreamEntry>(),
    toolStreamOrder: [] as string[],
    toolStreamSyncTimer: null,
    activityEntries: [],
    realtimeTalkActive: false,
    realtimeTalkStatus: "idle" as RealtimeTalkStatus,
    realtimeTalkDetail: null,
    realtimeTalkTranscript: null,
    realtimeTalkConversation: [],
    realtimeTalkOptionsOpen: false,
    realtimeTalkCatalogProviders: null,
    realtimeTalkOptions: {
      provider: "",
      model: "",
      voice: "",
      transport: "",
      vadThreshold: "",
      silenceDurationMs: "",
      prefixPaddingMs: "",
      reasoningEffort: "",
    },
    realtimeTalkSession: null,
    realtimeTalkConversationState: createRealtimeTalkConversationState(),
    requestUpdate,
    sessionWorkspaceState: undefined,
    sessionWorkspaceOpenRequest: undefined,
    querySelector: page.querySelector.bind(page),
  } as unknown as ChatPageHost;
  Object.defineProperty(state, "updateComplete", {
    enumerable: false,
    get: () => page.updateComplete,
  });

  state.resetToolStream = () => resetToolStream(state as never);
  state.onModelChanged = () => refreshVisibleToolsEffectiveForCurrentSession(state);
  state.resetChatInputHistoryNavigation = () => resetChatInputHistoryNavigation(state);
  state.resetChatScroll = () => resetChatScroll(state);
  state.scrollToBottom = (options) => {
    resetChatScroll(state);
    scheduleChatScroll(state, true, Boolean(options?.smooth), { source: "manual" });
  };
  state.handleChatScroll = (event) => handleChatScroll(state, event);
  state.handleChatDraftChange = (next) => handleChatDraftChange(state, next);
  state.handleChatInputHistoryKey = (input) => handleChatInputHistoryKey(state, input);
  state.applySettings = (next) => {
    state.settings = next;
    state.splitRatio = next.splitRatio;
    saveSettings(next);
    requestUpdate();
  };
  state.setChatMobileControlsOpen = (open, options) => {
    if (open) {
      state.chatMobileControlsTrigger = options?.trigger ?? state.chatMobileControlsTrigger;
      state.chatMobileControlsOpen = true;
      requestUpdate();
      return;
    }
    const focusTarget = options?.restoreFocus ? state.chatMobileControlsTrigger : null;
    state.chatMobileControlsOpen = false;
    state.chatMobileControlsTrigger = null;
    requestUpdate();
    if (!(focusTarget instanceof HTMLElement) || !focusTarget.isConnected) {
      return;
    }
    requestAnimationFrame(() => {
      if (focusTarget.isConnected) {
        focusTarget.focus();
      }
    });
  };
  state.resetRealtimeTalkConversation = () => {
    state.realtimeTalkConversationState = createRealtimeTalkConversationState();
    state.realtimeTalkConversation = [];
  };
  state.updateRealtimeTalkOptions = (next) => {
    state.realtimeTalkOptions = { ...state.realtimeTalkOptions, ...next };
    requestUpdate();
  };
  state.fetchRealtimeTalkCatalog = async () => {
    if (!state.client || !state.connected) {
      return;
    }
    const result = await state.client.request<{
      realtime?: { providers?: ChatProps["realtimeTalkCatalogProviders"] };
    }>("talk.catalog", {});
    state.realtimeTalkCatalogProviders = result.realtime?.providers ?? [];
    requestUpdate();
  };
  state.toggleRealtimeTalk = async () => {
    if (state.realtimeTalkSession) {
      state.realtimeTalkSession.stop();
      state.realtimeTalkSession = null;
      state.realtimeTalkActive = false;
      state.realtimeTalkStatus = "idle";
      state.realtimeTalkDetail = null;
      state.resetRealtimeTalkConversation();
      requestUpdate();
      return;
    }
    if (!state.client || !state.connected) {
      state.lastError = "Gateway not connected";
      state.chatError = state.lastError;
      requestUpdate();
      return;
    }
    const options = state.realtimeTalkOptions;
    const launchOptions: RealtimeTalkLaunchOptions = {
      provider: options.provider.trim() || undefined,
      model: options.model.trim() || undefined,
      voice: options.voice.trim() || undefined,
      transport: (options.transport.trim() || undefined) as RealtimeTalkLaunchOptions["transport"],
      vadThreshold: Number(options.vadThreshold) || undefined,
      silenceDurationMs: Number(options.silenceDurationMs) || undefined,
      prefixPaddingMs: Number(options.prefixPaddingMs) || undefined,
      reasoningEffort: options.reasoningEffort.trim() || undefined,
    };
    state.realtimeTalkActive = true;
    state.realtimeTalkStatus = "connecting";
    state.realtimeTalkDetail = null;
    state.resetRealtimeTalkConversation();
    const session = new RealtimeTalkSession(
      state.client,
      state.sessionKey,
      {
        onStatus: (status, detail) => {
          state.realtimeTalkStatus = status;
          state.realtimeTalkDetail = detail ?? null;
          state.realtimeTalkActive = status !== "idle";
          requestUpdate();
        },
        onTranscript: (entry) => {
          state.realtimeTalkTranscript = `${entry.role === "user" ? "You" : "OpenClaw"}: ${entry.text}`;
          state.realtimeTalkConversationState = updateRealtimeTalkConversation(
            state.realtimeTalkConversationState,
            entry,
          );
          state.realtimeTalkConversation = state.realtimeTalkConversationState.entries;
          requestUpdate();
        },
      },
      launchOptions,
    );
    state.realtimeTalkSession = session;
    try {
      await session.start();
    } catch (error) {
      session.stop();
      state.realtimeTalkSession = null;
      state.realtimeTalkActive = false;
      state.realtimeTalkStatus = "error";
      state.realtimeTalkDetail = error instanceof Error ? error.message : String(error);
      requestUpdate();
    }
  };
  state.loadAssistantIdentity = async () => {
    await loadPageAssistantIdentity(state);
  };
  state.handleSendChat = async (messageOverride, options) => {
    await handleSendChat(state, messageOverride, options as never);
    requestUpdate();
  };
  state.handleAbortChat = async (options) => {
    await handleAbortChat(state, options as never);
    requestUpdate();
  };
  state.removeQueuedMessage = (id) => {
    removeQueuedMessage(state, id);
    requestUpdate();
  };
  state.retryQueuedChatMessage = async (id) => {
    await retryQueuedChatMessage(state, id);
    requestUpdate();
  };
  state.steerQueuedChatMessage = async (id) => {
    await steerQueuedChatMessage(state, id);
    requestUpdate();
  };
  state.handleOpenSidebar = (content) => {
    state.sidebarContent = content;
    state.sidebarOpen = true;
    requestUpdate();
  };
  state.handleCloseSidebar = () => {
    state.sidebarOpen = false;
    requestUpdate();
  };
  state.handleSplitRatioChange = (ratio) => {
    const next = Math.max(0.4, Math.min(0.7, ratio));
    state.applySettings({ ...state.settings, splitRatio: next });
  };
  return state;
}

function handlePageGatewayEvent(state: ChatPageHost, event: GatewayEventFrame) {
  if (event.event === "chat") {
    handleChatGatewayEvent(
      state as unknown as ChatState,
      event.payload as ChatEventPayload | undefined,
    );
    requestPageUpdate(state);
    return;
  }
  if (event.event === "chat.side_result") {
    if (handleChatSideResultGatewayEvent(state as unknown as ChatState, event.payload)) {
      requestPageUpdate(state);
    }
    return;
  }
  if (event.event === "agent" || event.event === "session.tool") {
    handleAgentEvent(state as never, event.payload as never);
    requestPageUpdate(state);
    return;
  }
  if (event.event === "session.operation") {
    handleSessionOperationEvent(state as never, event.payload as never);
    requestPageUpdate(state);
    return;
  }
  if (event.event === "chat.send_timing") {
    recordChatSendServerTiming(state, event.payload);
    return;
  }
  if (event.event === "sessions.changed" || event.event === "session.message") {
    void refreshPageChat(state).finally(() => requestPageUpdate(state));
  }
}

function requestPageUpdate(state: ChatPageHost) {
  state.requestUpdate?.();
}

export class ChatPage extends LitElement {
  @consume({ context: applicationContext, subscribe: false })
  private context!: ChatPageContext;
  @property({ attribute: false }) data!: ChatRouteData;

  private state: ChatPageHost | undefined;
  private stopGatewaySnapshot: (() => void) | undefined;
  private stopGatewayEvents: (() => void) | undefined;
  private stopConfigSubscription: (() => void) | undefined;
  private stopSessionsSubscription: (() => void) | undefined;
  private connectedClient: GatewayBrowserClient | null = null;
  private readonly composerPersistence = new ChatComposerPersistenceController(
    this,
    () => this.state,
  );
  private pendingCreatedSessionComposer: {
    sessionKey: string;
    chatMessage: string;
    chatAttachments: ChatAttachment[];
  } | null = null;

  private applyRouteSessionKey(sessionKey: string) {
    const state = this.state;
    if (!state) {
      return;
    }
    const nextSessionKey = resolveSessionKey(sessionKey, this.context.gateway.snapshot.hello);
    if (!nextSessionKey) {
      return;
    }
    state.sessionKey = nextSessionKey;
    saveRouteSessionSettings(state, nextSessionKey);
    const agentId = parseAgentSessionKey(nextSessionKey)?.agentId;
    if (agentId) {
      this.context.agentSelection.set(agentId);
    }
  }

  private switchRouteSession(nextSessionKey: string) {
    const state = this.state;
    if (!state) {
      return;
    }
    const previousSessionKey = state.sessionKey;
    const previousSessionsResult = state.sessionsResult;
    const nextSessionRow = state.sessionsResult?.sessions.find((row) => row.key === nextSessionKey);
    const nextSessionLabel = resolveSessionDisplayName(nextSessionKey, nextSessionRow);
    resetChatStateForRouteSession(state, nextSessionKey);
    if (previousSessionKey !== nextSessionKey) {
      state.announceSessionSwitch?.(nextSessionKey, nextSessionLabel);
    }
    void state.loadAssistantIdentity();
    void refreshChatAvatar(state);
    void refreshSlashCommands({
      client: state.client,
      agentId: parseAgentSessionKey(nextSessionKey)?.agentId,
    });
    const subscriptionSync = syncSelectedSessionMessageSubscription(state);
    const historyLoad = loadChatHistory(state);
    state.requestUpdate();
    const scheduleHistoryScroll = () => {
      if (state.sessionKey !== nextSessionKey) {
        return;
      }
      state.requestUpdate();
      scheduleChatScroll(state, true);
    };
    void historyLoad.then(scheduleHistoryScroll, scheduleHistoryScroll);
    const sessionsRefresh = refreshRouteSessionOptions(state);
    flushChatQueueAfterIdleSessionReconciliation(
      state,
      nextSessionKey,
      historyLoad,
      sessionsRefresh,
      previousSessionsResult,
    );
    void subscriptionSync;
    void historyLoad;
    void sessionsRefresh;
  }

  private readonly handleCommandPaletteSlashCommand = (command: string) => {
    const state = this.state;
    if (!state) {
      return;
    }
    state.handleChatDraftChange(command.endsWith(" ") ? command : `${command} `);
    state.requestUpdate?.();
  };

  private announceCommandPaletteTarget(
    onSlashCommand: CommandPaletteTargetDetail["onSlashCommand"],
  ) {
    this.dispatchEvent(
      new CustomEvent<CommandPaletteTargetDetail>(COMMAND_PALETTE_TARGET_EVENT, {
        bubbles: true,
        composed: true,
        detail: {
          owner: this,
          onSlashCommand,
        },
      }),
    );
  }

  private readonly createSession = async (): Promise<boolean> => {
    const state = this.state;
    if (!state || !state.client || !state.connected) {
      return false;
    }
    if (!canCreateChatSession(state)) {
      state.lastError = NEW_SESSION_ACTIVE_RUN_MESSAGE;
      state.chatError = state.lastError;
      state.requestUpdate?.();
      return false;
    }
    if (state.sessionsLoading) {
      state.lastError = NEW_SESSION_LIST_LOADING_MESSAGE;
      state.chatError = state.lastError;
      state.requestUpdate?.();
      return false;
    }

    state.lastError = null;
    state.chatError = null;
    const previousSessionKey = state.sessionKey;
    const preservedDraft = state.chatMessage;
    const preservedAttachments = state.chatAttachments;
    const nextSessionKey = await this.context.sessions.create({
      currentSessionKey: previousSessionKey,
      agentId:
        scopedAgentParamsForSession(state, previousSessionKey).agentId ??
        resolveAgentIdFromSessionKey(previousSessionKey),
    });
    if (
      !nextSessionKey ||
      state.sessionKey !== previousSessionKey ||
      !canCreateChatSession(state)
    ) {
      if (!nextSessionKey) {
        state.lastError =
          state.sessionsError ??
          (state.sessionsLoading
            ? NEW_SESSION_LIST_LOADING_MESSAGE
            : NEW_SESSION_CREATE_FAILED_MESSAGE);
        state.chatError = state.lastError;
        state.requestUpdate?.();
      }
      return false;
    }
    this.pendingCreatedSessionComposer = {
      sessionKey: nextSessionKey,
      chatMessage: preservedDraft,
      chatAttachments: preservedAttachments,
    };
    this.context.navigate("chat", {
      search: searchForSession(nextSessionKey),
    });
    return true;
  };

  private readonly handleDocumentKeydown = (event: KeyboardEvent) => {
    if (event.defaultPrevented || event.key !== "Escape") {
      return;
    }
    const state = this.state;
    if (!state) {
      return;
    }
    const openDetails = this.querySelectorAll<HTMLDetailsElement>(CHAT_OPEN_DETAILS_SELECTOR);
    if (openDetails.length > 0) {
      event.preventDefault();
      openDetails.forEach((details) => {
        details.open = false;
      });
      return;
    }
    if (state.realtimeTalkOptionsOpen) {
      event.preventDefault();
      state.realtimeTalkOptionsOpen = false;
      state.requestUpdate();
      return;
    }
    if (!state.chatMobileControlsOpen) {
      return;
    }
    event.preventDefault();
    state.setChatMobileControlsOpen(false, { restoreFocus: true });
  };

  private readonly handleDocumentPointerdown = (event: PointerEvent) => {
    const state = this.state;
    if (!state) {
      return;
    }
    const path = event.composedPath();
    let changed = false;
    this.querySelectorAll<HTMLDetailsElement>(CHAT_OPEN_DETAILS_SELECTOR).forEach((details) => {
      if (!path.includes(details)) {
        details.open = false;
        changed = true;
      }
    });
    if (state.realtimeTalkOptionsOpen) {
      const insideTalkOptions = Array.from(
        this.querySelectorAll(
          ".agent-chat__talk-options, [aria-label='Talk settings'], [aria-label='Talk options']",
        ),
      ).some((node) => path.includes(node));
      if (!insideTalkOptions) {
        state.realtimeTalkOptionsOpen = false;
        changed = true;
      }
    }
    if (changed) {
      state.requestUpdate();
    }
    if (!state.chatMobileControlsOpen) {
      return;
    }
    const wrapper =
      this.querySelector(".chat-settings-popover-wrapper") ??
      this.querySelector(".chat-mobile-controls-wrapper");
    if (wrapper && path.includes(wrapper)) {
      return;
    }
    state.setChatMobileControlsOpen(false);
  };

  override createRenderRoot() {
    return this;
  }

  override connectedCallback() {
    super.connectedCallback();
    document.addEventListener("keydown", this.handleDocumentKeydown, true);
    document.addEventListener("pointerdown", this.handleDocumentPointerdown, true);
    this.state = createPageState(
      this.context,
      () => {
        this.composerPersistence.persistQueueIfChanged();
        this.requestUpdate();
      },
      this,
    );
    const handleChatDraftChange = this.state.handleChatDraftChange;
    this.state.handleChatDraftChange = (next) => {
      handleChatDraftChange(next);
      this.composerPersistence.schedule();
    };
    this.announceCommandPaletteTarget(this.handleCommandPaletteSlashCommand);
    if (this.data?.sessionKey) {
      this.applyRouteSessionKey(this.data.sessionKey);
    }
    this.composerPersistence.restore({ preserveCurrent: true });
    if (this.data?.draft !== undefined) {
      this.state.handleChatDraftChange(this.data.draft);
    }
    this.composerPersistence.start();
    this.stopGatewaySnapshot = this.context.gateway.subscribe((snapshot) => {
      this.applyGatewaySnapshot(snapshot);
    });
    this.stopGatewayEvents = this.context.gateway.subscribeEvents((event) => {
      const state = this.state;
      if (state) {
        handlePageGatewayEvent(state, event);
      }
    });
    this.applyApplicationConfig(this.context.config.current);
    this.stopConfigSubscription = this.context.config.subscribe((config) => {
      this.applyApplicationConfig(config);
    });
    this.applySessionsState(this.context.sessions.state);
    this.stopSessionsSubscription = this.context.sessions.subscribe((state) => {
      this.applySessionsState(state);
    });
    this.applyGatewaySnapshot(this.context.gateway.snapshot);
  }

  override willUpdate(changedProperties: Map<PropertyKey, unknown>) {
    if (changedProperties.has("data") && this.state && this.data) {
      const nextSessionKey = resolveSessionKey(
        this.data.sessionKey,
        this.context.gateway.snapshot.hello,
      );
      if (nextSessionKey && nextSessionKey !== this.state.sessionKey) {
        this.switchRouteSession(nextSessionKey);
      } else if (nextSessionKey) {
        this.applyRouteSessionKey(nextSessionKey);
      }
      const pending = this.pendingCreatedSessionComposer;
      if (pending?.sessionKey === nextSessionKey) {
        this.pendingCreatedSessionComposer = null;
        this.state.chatMessage = pending.chatMessage;
        this.state.chatAttachments = pending.chatAttachments;
        this.composerPersistence.persistNow();
      }
      if (this.data.draft !== undefined && this.data.draft !== this.state.chatMessage) {
        this.state.handleChatDraftChange(this.data.draft);
      }
    }
  }

  override disconnectedCallback() {
    this.composerPersistence.stop();
    this.announceCommandPaletteTarget(null);
    document.removeEventListener("keydown", this.handleDocumentKeydown, true);
    document.removeEventListener("pointerdown", this.handleDocumentPointerdown, true);
    this.stopGatewaySnapshot?.();
    this.stopGatewaySnapshot = undefined;
    this.stopGatewayEvents?.();
    this.stopGatewayEvents = undefined;
    this.stopConfigSubscription?.();
    this.stopConfigSubscription = undefined;
    this.stopSessionsSubscription?.();
    this.stopSessionsSubscription = undefined;
    if (this.state) {
      this.state.realtimeTalkSession?.stop();
      this.state.realtimeTalkSession = null;
      this.state.resetToolStream();
    }
    resetChatViewState();
    this.state = undefined;
    this.connectedClient = null;
    super.disconnectedCallback();
  }

  private applySessionsState(stateValue: ApplicationContext["sessions"]["state"]) {
    const state = this.state;
    if (!state) {
      return;
    }
    for (const sessionKey of stateValue.deletedKeys) {
      clearChatMessagesFromCache(state.chatMessagesBySession, state, { sessionKey });
    }
    state.sessionsResult = stateValue.result;
    state.sessionsResultAgentId = stateValue.agentId;
    state.sessionsLoading = stateValue.loading;
    state.sessionsError = stateValue.error;
    state.requestUpdate?.();
  }

  private applyApplicationConfig(config: ApplicationContext["config"]["current"]) {
    const state = this.state;
    if (!state) {
      return;
    }
    const rootsChanged =
      state.localMediaPreviewRoots.length !== config.localMediaPreviewRoots.length ||
      state.localMediaPreviewRoots.some(
        (value, index) => value !== config.localMediaPreviewRoots[index],
      );
    if (
      !rootsChanged &&
      state.embedSandboxMode === config.embedSandboxMode &&
      state.allowExternalEmbedUrls === config.allowExternalEmbedUrls &&
      state.chatMessageMaxWidth === config.chatMessageMaxWidth
    ) {
      return;
    }
    state.localMediaPreviewRoots = config.localMediaPreviewRoots;
    state.embedSandboxMode = config.embedSandboxMode;
    state.allowExternalEmbedUrls = config.allowExternalEmbedUrls;
    state.chatMessageMaxWidth = config.chatMessageMaxWidth;
    state.requestUpdate?.();
  }

  private applyGatewaySnapshot(snapshot: ApplicationGatewaySnapshot) {
    const state = this.state;
    if (!state) {
      return;
    }
    const wasConnected = state.connected;
    const clientChanged = this.connectedClient !== snapshot.client;
    state.client = snapshot.client;
    state.connected = snapshot.connected;
    state.hello = snapshot.hello;
    state.assistantAgentId = snapshot.assistantAgentId;
    const routeSessionKey = this.data?.sessionKey?.trim();
    const canonicalRouteSessionKey = routeSessionKey
      ? resolveSessionKey(routeSessionKey, snapshot.hello)
      : null;
    if (
      routeSessionKey &&
      canonicalRouteSessionKey &&
      canonicalRouteSessionKey !== routeSessionKey
    ) {
      this.context.replace("chat", {
        search: searchForSession(canonicalRouteSessionKey),
      });
      state.requestUpdate?.();
      return;
    }
    state.assistantName = this.context.assistantName;
    if (!snapshot.connected) {
      if (wasConnected) {
        const currentSessionId =
          typeof state.currentSessionId === "string" ? state.currentSessionId.trim() : "";
        if (currentSessionId) {
          state.reconnectResumeSessionId = currentSessionId;
        }
        markQueuedChatSendsWaitingForReconnect(state);
      }
      this.connectedClient = null;
      state.realtimeTalkSession?.stop();
      state.realtimeTalkSession = null;
      state.realtimeTalkActive = false;
      state.realtimeTalkStatus = "idle";
      state.resetToolStream();
      state.requestUpdate?.();
      return;
    }
    if (clientChanged) {
      this.connectedClient = snapshot.client;
      void retryReconnectableQueuedChatSends(state);
      void refreshPageChat(state, { startup: true }).finally(() => state.requestUpdate?.());
      void state.loadAssistantIdentity();
    }
    state.requestUpdate?.();
  }

  override render() {
    const state = this.state;
    if (!state) {
      return html`<main class="app-shell app-shell--booting" aria-busy="true"></main>`;
    }
    const currentAgentId = resolveChatAgentId(state);
    const props: ChatProps = {
      sessionKey: state.sessionKey,
      onSessionKeyChange: (next) => {
        this.context.navigate("chat", {
          search: searchForSession(next),
        });
      },
      thinkingLevel: state.chatThinkingLevel,
      autoExpandToolCalls: state.chatVerboseLevel === "full",
      showThinking: state.settings.chatShowThinking,
      showToolCalls: state.settings.chatShowToolCalls,
      loading: state.chatLoading,
      sending: state.chatSending,
      canAbort: hasAbortableSessionRun(state),
      runStatus: state.chatRunStatus,
      compactionStatus: state.compactionStatus,
      fallbackStatus: state.fallbackStatus,
      messages: state.chatMessages,
      sideResult: state.chatSideResult,
      toolMessages: state.chatToolMessages,
      streamSegments: state.chatStreamSegments,
      stream: state.chatStream,
      streamStartedAt: state.chatStreamStartedAt,
      assistantAvatarUrl: resolveChatAvatarUrl(state),
      draft: state.chatMessage,
      queue: state.chatQueue,
      realtimeTalkActive: state.realtimeTalkActive,
      realtimeTalkStatus: state.realtimeTalkStatus,
      realtimeTalkDetail: state.realtimeTalkDetail,
      realtimeTalkTranscript: state.realtimeTalkTranscript,
      realtimeTalkConversation: state.realtimeTalkConversation,
      realtimeTalkOptionsOpen: state.realtimeTalkOptionsOpen,
      realtimeTalkCatalogProviders: state.realtimeTalkCatalogProviders,
      realtimeTalkOptions: state.realtimeTalkOptions,
      connected: state.connected,
      canSend: state.connected,
      disabledReason: state.connected ? null : "Disconnected",
      error: state.lastError,
      sessions: state.sessionsResult,
      composerControls: renderChatControls({
        agentsList: state.agentsList,
        connected: state.connected,
        hideCronSessions: state.sessionsHideCron,
        loading: state.chatLoading,
        manualRefreshInFlight: state.chatManualRefreshInFlight,
        model: {
          activeRunId: state.chatRunId,
          connected: state.connected,
          gatewayAvailable: Boolean(state.client),
          loading: state.chatLoading,
          modelCatalog: state.chatModelCatalog,
          modelOverrides: state.sessions.state.modelOverrides,
          modelSwitching: Boolean(state.chatModelSwitchPromises[state.sessionKey]),
          modelsLoading: state.chatModelsLoading,
          sending: state.chatSending,
          sessionKey: state.sessionKey,
          sessionsResult: state.sessionsResult,
          stream: state.chatStream,
          onFastModeSelect: (next) => switchChatFastMode(state, next),
          onModelSelect: (next) => switchChatModel(state, next),
          onThinkingSelect: (next) => switchChatThinkingLevel(state, next),
        },
        onboarding: state.onboarding,
        quota: {
          basePath: state.basePath,
          modelAuthStatusResult: state.modelAuthStatusResult,
          onNavigate: (target) => this.context.navigate(target),
        },
        runId: state.chatRunId,
        sending: state.chatSending,
        settings: state.settings,
        settingsOpen: state.chatMobileControlsOpen,
        sessionKey: state.sessionKey,
        sessionsResult: state.sessionsResult,
        stream: state.chatStream,
        onRefresh: () => handleChatManualRefresh(state),
        onSettingsChange: state.applySettings,
        onSettingsOpenChange: state.setChatMobileControlsOpen,
        onToggleCronSessions: () => {
          state.sessionsHideCron = !state.sessionsHideCron;
          state.requestUpdate?.();
        },
      }),
      sessionWorkspace: createSessionWorkspaceProps(state),
      onRefresh: () => {
        state.chatSideResult = null;
        state.resetToolStream();
        void refreshPageChat(state, { awaitHistory: true, scheduleScroll: false });
      },
      onChatScroll: state.handleChatScroll,
      getDraft: () => state.chatMessage,
      onDraftChange: state.handleChatDraftChange,
      onRequestUpdate: state.requestUpdate,
      onHistoryKeydown: state.handleChatInputHistoryKey,
      onSlashIntent: () => refreshChatCommands(state),
      showNewMessages: state.chatNewMessagesBelow && !state.chatManualRefreshInFlight,
      onScrollToBottom: state.scrollToBottom,
      attachments: state.chatAttachments,
      onAttachmentsChange: (next) => {
        state.chatAttachments = next;
        state.requestUpdate?.();
      },
      onSend: () => void state.handleSendChat(),
      onCompact: () => void state.handleSendChat("/compact"),
      onToggleRealtimeTalk: () => void state.toggleRealtimeTalk(),
      onToggleRealtimeTalkOptions: () => {
        state.realtimeTalkOptionsOpen = !state.realtimeTalkOptionsOpen;
        if (state.realtimeTalkOptionsOpen) {
          void state.fetchRealtimeTalkCatalog();
        }
        state.requestUpdate?.();
      },
      onRealtimeTalkOptionsChange: state.updateRealtimeTalkOptions,
      onDismissError: () => {
        dismissChatError(state as never);
        state.requestUpdate?.();
      },
      onDismissRealtimeTalkError: () => {
        dismissRealtimeTalkError(state as never);
        state.requestUpdate?.();
      },
      onAbort: () => void state.handleAbortChat({ preserveDraft: true }),
      onQueueRemove: state.removeQueuedMessage,
      onQueueRetry: (id) => void state.retryQueuedChatMessage(id),
      onQueueSteer: (id) => void state.steerQueuedChatMessage(id),
      onDismissSideResult: () => {
        state.chatSideResult = null;
        state.requestUpdate?.();
      },
      replyTarget: state.chatReplyTarget ?? null,
      onClearReply: () => {
        state.chatReplyTarget = null;
        state.requestUpdate?.();
      },
      onSetReply: (target) => {
        state.chatReplyTarget = target;
        state.requestUpdate?.();
      },
      onNewSession: () => void this.createSession(),
      onClearHistory: () => void clearChatHistory(state),
      agentsList: state.agentsList,
      currentAgentId,
      fullMessageAgentId: scopedAgentParamsForSession(state, state.sessionKey).agentId,
      onAgentChange: (agentId) => {
        this.context.agentSelection.set(agentId);
        const nextSessionKey = buildAgentMainSessionKey({ agentId });
        this.context.navigate("chat", {
          search: searchForSession(nextSessionKey),
        });
      },
      onSessionSelect: (next) => {
        this.context.navigate("chat", {
          search: searchForSession(next),
        });
      },
      client: state.client,
      sidebarOpen: state.sidebarOpen,
      sidebarContent: state.sidebarContent,
      splitRatio: state.splitRatio,
      canvasPluginSurfaceUrl: state.hello?.pluginSurfaceUrls?.canvas ?? null,
      onOpenSidebar: state.handleOpenSidebar,
      onCloseSidebar: state.handleCloseSidebar,
      onSplitRatioChange: state.handleSplitRatioChange,
      assistantName: state.assistantName,
      assistantAvatar: state.assistantAvatar,
      userName: state.userName,
      userAvatar: state.userAvatar,
      localMediaPreviewRoots: state.localMediaPreviewRoots,
      embedSandboxMode: state.embedSandboxMode,
      allowExternalEmbedUrls: state.allowExternalEmbedUrls,
      chatMessageMaxWidth: state.chatMessageMaxWidth,
      assistantAttachmentAuthToken: resolveAssistantAttachmentAuthToken(state as never),
      onAssistantAttachmentLoaded: () => state.scrollToBottom(),
      basePath: state.basePath,
    };
    return renderChat(props);
  }
}

if (!customElements.get("openclaw-chat-page")) {
  customElements.define("openclaw-chat-page", ChatPage);
}
