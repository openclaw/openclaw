import type { ReactiveController, ReactiveControllerHost } from "lit";
import type { GatewayBrowserClient, GatewayEventFrame } from "../../api/gateway.ts";
import type { AgentsListResult, ModelCatalogEntry, SessionsListResult } from "../../api/types.ts";
import {
  fetchAssistantIdentity,
  loadLocalAssistantIdentity,
} from "../../app/assistant-identity.ts";
import { resolveControlUiAuthToken } from "../../app/control-ui-auth.ts";
import {
  loadLocalUserIdentity,
  loadSettings,
  saveSettings,
  type UiSettings,
} from "../../app/settings.ts";
import { refreshVisibleToolsEffectiveForCurrentSession } from "../../lib/agents/tools-effective.ts";
import { isRenderableControlUiAvatarUrl } from "../../lib/avatar.ts";
import type { ChatAttachment, ChatQueueItem } from "../../lib/chat/chat-types.ts";
import type { EmbedSandboxMode } from "../../lib/chat/tool-display.ts";
import { isGatewayMethodAdvertised } from "../../lib/gateway-methods.ts";
import { scopedAgentParamsForSession, type SessionCapability } from "../../lib/sessions/index.ts";
import {
  normalizeAgentId,
  parseAgentSessionKey,
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
  type ChatEventPayload,
  type ChatMetadataResult,
  type ChatState,
} from "./chat-gateway.ts";
import {
  handleAbortChat,
  handleSendChat,
  recordChatSendServerTiming,
  refreshChat,
  removeQueuedMessage,
  retryQueuedChatMessage,
  steerQueuedChatMessage,
  type ChatHost,
} from "./chat-send.ts";
import { refreshCurrentChatSessionList } from "./chat-session.ts";
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
import { cacheChatMessages, readChatMessagesFromCache } from "./session-message-cache.ts";
import type { SessionWorkspaceHost } from "./session-workspace.ts";
import type { ChatProps } from "./view.ts";

type ChatPageElement = {
  querySelector: (selectors: string) => Element | null;
  readonly updateComplete: Promise<unknown>;
};

export type ChatPageHost = ChatHost &
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

type PendingCreatedSessionComposer = {
  sessionKey: string;
  chatMessage: string;
  chatAttachments: ChatAttachment[];
};

export function canCreateChatSession(
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

export async function handleChatManualRefresh(state: ChatPageHost): Promise<void> {
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

export function resolveAssistantAttachmentAuthToken(state: ChatPageHost) {
  return resolveControlUiAuthToken(state);
}

export function dismissChatError(state: ChatPageHost) {
  state.lastError = null;
  state.lastErrorCode = null;
  state.chatError = null;
}

export function dismissRealtimeTalkError(state: ChatPageHost) {
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

export function saveRouteSessionSettings(state: ChatPageHost, sessionKey: string) {
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

export function resetChatStateForRouteSession(state: ChatPageHost, sessionKey: string) {
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

export async function refreshRouteSessionOptions(state: ChatPageHost) {
  await refreshCurrentChatSessionList(state);
}

export function resolveChatAgentId(
  state: Pick<ChatPageHost, "sessionKey" | "agentsList" | "assistantAgentId" | "hello">,
) {
  return normalizeAgentId(
    parseAgentSessionKey(state.sessionKey)?.agentId ??
      scopedAgentParamsForSession(state, state.sessionKey).agentId ??
      resolveUiSelectedGlobalAgentId(state),
  );
}

export function resolveChatAvatarUrl(
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

export async function refreshChatCommands(host: ChatPageHost) {
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

export function refreshPageChat(host: ChatPageHost, opts?: ChatRefreshOptions) {
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

export function createPageState(
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

export function handlePageGatewayEvent(state: ChatPageHost, event: GatewayEventFrame) {
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

export class ChatStateController<TState extends ChatPageHost> implements ReactiveController {
  private readonly composerPersistence: ChatComposerPersistenceController;
  private stateValue: TState | undefined;
  private pendingCreatedSessionComposer: PendingCreatedSessionComposer | null = null;
  private readonly cleanups: Array<() => void> = [];
  private disposed = false;

  constructor(private readonly host: ReactiveControllerHost) {
    host.addController(this);
    this.composerPersistence = new ChatComposerPersistenceController(host, () => this.stateValue);
  }

  get state(): TState | undefined {
    return this.stateValue;
  }

  attach(state: TState) {
    this.stateValue = state;
    state.requestUpdate = this.requestUpdate;
    const commitDraftChange = state.handleChatDraftChange;
    state.handleChatDraftChange = (next) => {
      commitDraftChange(next);
      this.composerPersistence.schedule();
    };
  }

  addCleanup(cleanup: () => void) {
    this.cleanups.push(cleanup);
  }

  readonly requestUpdate = () => {
    this.composerPersistence.persistQueueIfChanged();
    this.host.requestUpdate();
  };

  restoreComposer(options: { preserveCurrent?: boolean } = {}) {
    this.composerPersistence.restore(options);
  }

  startComposerPersistence() {
    this.composerPersistence.start();
  }

  captureCreatedSessionComposer(sessionKey: string) {
    const state = this.stateValue;
    if (!state) {
      return;
    }
    this.pendingCreatedSessionComposer = {
      sessionKey,
      chatMessage: state.chatMessage,
      chatAttachments: state.chatAttachments,
    };
  }

  restoreCreatedSessionComposer(sessionKey: string | null | undefined): boolean {
    const state = this.stateValue;
    const pending = this.pendingCreatedSessionComposer;
    if (!state || !pending || pending.sessionKey !== sessionKey) {
      return false;
    }
    this.pendingCreatedSessionComposer = null;
    state.chatMessage = pending.chatMessage;
    state.chatAttachments = pending.chatAttachments;
    this.composerPersistence.persistNow();
    return true;
  }

  stop() {
    this.composerPersistence.stop();
    while (this.cleanups.length > 0) {
      this.cleanups.pop()?.();
    }
    const state = this.stateValue;
    state?.realtimeTalkSession?.stop();
    if (state) {
      state.realtimeTalkSession = null;
      state.resetToolStream?.();
    }
  }

  dispose() {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.stop();
    this.host.removeController(this.composerPersistence);
    this.host.removeController(this);
    this.stateValue = undefined;
    this.pendingCreatedSessionComposer = null;
  }

  hostDisconnected() {
    this.stop();
  }
}
