import type { ReactiveController, ReactiveControllerHost } from "lit";
import type { GatewayBrowserClient, GatewayEventFrame } from "../../api/gateway.ts";
import type {
  AgentsListResult,
  GatewaySessionRow,
  ModelAuthStatusResult,
  ModelCatalogEntry,
  SessionsListResult,
} from "../../api/types.ts";
import {
  fetchAssistantIdentity,
  loadLocalAssistantIdentity,
} from "../../app/assistant-identity.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { resolveControlUiAuthToken } from "../../app/control-ui-auth.ts";
import {
  loadLocalUserIdentity,
  loadSettings,
  patchSettings,
  type UiSettings,
} from "../../app/settings.ts";
import { isRenderableControlUiAvatarUrl } from "../../lib/avatar.ts";
import type { ChatAttachment, ChatQueueItem } from "../../lib/chat/chat-types.ts";
import type { EmbedSandboxMode } from "../../lib/chat/tool-display.ts";
import { isGatewayMethodAdvertised } from "../../lib/gateway-methods.ts";
import { loadModelAuthStatus } from "../../lib/model-auth.ts";
import { scopedAgentParamsForSession, type SessionCapability } from "../../lib/sessions/index.ts";
import {
  readSessionChangedEvent,
  type SessionChangedResult,
} from "../../lib/sessions/reconcile.ts";
import {
  areUiSessionKeysEquivalent,
  isUiGlobalSessionKey,
  normalizeAgentId,
  parseAgentSessionKey,
  resolveUiDefaultAgentId,
  resolveUiGlobalAliasAgentId,
  resolveUiSelectedGlobalAgentId,
} from "../../lib/sessions/session-key.ts";
import { refreshChatAvatar, resolveAgentIdForSession } from "./chat-avatar.ts";
import { applyRemoteSlashCommandsResult, refreshSlashCommands } from "./chat-commands.ts";
import {
  handleChatGatewayEvent,
  handleChatSideResultGatewayEvent,
  type ChatEventPayload,
} from "./chat-gateway.ts";
import {
  chatScopedEventSessionMatches,
  loadChatHistory,
  type ChatMetadataResult,
  type ChatState,
} from "./chat-history.ts";
import { clearPendingQueueItemsForRun, removeQueuedMessage } from "./chat-queue.ts";
import {
  attachChatRealtimeActions,
  createDefaultRealtimeTalkOptions,
  createInitialChatRealtimeState,
  resetChatRealtimeConversation,
  type ChatRealtimeState,
} from "./chat-realtime.ts";
import type { ChatSendTimingEntry } from "./chat-send-contract.ts";
import { recordChatSendServerTiming } from "./chat-send-timing.ts";
import {
  flushChatQueueForEvent,
  handleSendChat,
  retryQueuedChatMessage,
  steerQueuedChatMessage,
  type ChatHost,
} from "./chat-send.ts";
import {
  flushChatQueueAfterIdleSessionReconciliation,
  refreshCurrentChatSessionList,
} from "./chat-session.ts";
import type { ChatProps } from "./chat-view.ts";
import {
  clearSessionWorkspaceTimers,
  type SessionWorkspaceHost,
} from "./components/chat-session-workspace.ts";
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
import { applyModelCatalogResult, loadModels } from "./models.ts";
import {
  handleAbortChat,
  reconcileChatRunFromCurrentSessionRow,
  reconcileChatRunFromSessionRow,
  reconcileChatRunLifecycle,
  reconcileStaleChatRunAfterSessionStatePublication,
} from "./run-lifecycle.ts";
import { scheduleChatScroll, handleChatScroll, resetChatScroll } from "./scroll.ts";
import { cacheChatMessages, readChatMessagesFromCache } from "./session-message-cache.ts";
import {
  handleAgentEvent,
  handleSessionOperationEvent,
  resetToolStream,
  type CompactionStatus,
  type FallbackStatus,
  type ToolStreamEntry,
} from "./tool-stream.ts";

type ChatPageElement = {
  querySelector: (selectors: string) => Element | null;
  readonly updateComplete: Promise<unknown>;
};

export type ChatPageHost = ChatHost &
  ChatState &
  ChatRealtimeState &
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
    basePath: string;
    chatAvatarUrl: string | null;
    chatAvatarSource: string | null;
    chatAvatarStatus: "none" | "local" | "remote" | "data" | null;
    chatAvatarReason: string | null;
    chatSideResultTerminalRuns: Set<string>;
    chatModelSwitchPromises: Record<string, Promise<boolean>>;
    chatModelCatalog: ModelCatalogEntry[];
    modelAuthStatusResult: ModelAuthStatusResult | null;
    modelAuthStatusError: string | null;
    sessionsResult: SessionsListResult | null;
    sessionsResultAgentId: string | null;
    sessionsError: string | null;
    sessionsShowArchived: boolean;
    selectedChatSessionArchived: boolean;
    agentsList: AgentsListResult | null;
    agentsSelectedId: string | null;
    refreshSessionsAfterChat: Map<string, { sessionKey: string; agentId?: string }>;
    pendingAbort: { runId?: string | null; sessionKey: string; agentId?: string } | null;
    pendingSessionMessageReloadSessionKey: string | null;
    chatSubmitGuards: Map<string, Promise<void>>;
    chatSendTimingsByRun: Map<string, ChatSendTimingEntry>;
    chatStreamSegments: Array<{ text: string; ts: number }>;
    toolStreamById: Map<string, ToolStreamEntry>;
    toolStreamOrder: string[];
    toolStreamSyncTimer: number | null;
    compactionStatus: CompactionStatus | null;
    fallbackStatus: FallbackStatus | null;
    chatRunStatus: ChatProps["runStatus"];
    chatNewMessagesBelow: boolean;
    chatManualRefreshInFlight: boolean;
    chatModelsLoading: boolean;
    chatMobileControlsOpen: boolean;
    chatMobileControlsTrigger: HTMLElement | null;
    sessionsHideCron: boolean;
    sessionsLoading: boolean;
    lastErrorCode: string | null;
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
    requestUpdate: () => void;
    onModelChanged: () => Promise<void> | void;
    resetToolStream: () => void;
    resetChatScroll: () => void;
    resetChatInputHistoryNavigation: () => void;
    scrollToBottom: (opts?: { smooth?: boolean }) => void;
    setChatMobileControlsOpen: (
      open: boolean,
      options?: { trigger?: HTMLElement | null; restoreFocus?: boolean },
    ) => void;
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
    announceSessionSwitch?: (sessionKey: string, label: string) => void;
    createChatSession?: () => Promise<void>;
    exportCurrentChat?: () => Promise<void> | void;
    refreshCurrentSessionTools?: () => Promise<void>;
    refreshCurrentChat?: () => Promise<void>;
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
    await Promise.allSettled([
      refreshPageChat(state, { awaitHistory: true, scheduleScroll: false }),
      refreshChatModelAuthStatus(state, { refresh: true }),
    ]);
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
  state.settings = patchSettings({
    sessionKey,
    lastActiveSessionKey: sessionKey,
  });
}

export function resetChatStateForRouteSession(state: ChatPageHost, sessionKey: string) {
  const previousSessionKey = state.sessionKey;
  persistChatComposerState(state, previousSessionKey);
  saveChatQueueForSession(state, previousSessionKey);
  saveChatMessagesForSession(state, previousSessionKey);
  state.sessionKey = sessionKey;
  state.selectedChatSessionArchived =
    state.sessionsResult?.sessions.some(
      (row) => row.archived === true && areUiSessionKeysEquivalent(row.key, sessionKey),
    ) === true;
  state.currentSessionId = null;
  state.reconnectResumeSessionId = null;
  state.chatMessage = "";
  state.chatAttachments = [];
  state.chatReplyTarget = null;
  state.chatMessages = restoreChatMessagesForSession(state, sessionKey);
  state.chatToolMessages = [];
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
  resetChatRealtimeConversation(state);
  state.realtimeTalkOptions = createDefaultRealtimeTalkOptions();
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
  if (state.chatAvatarUrl) {
    return state.chatAvatarUrl;
  }
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
  const agent = state.agentsList?.agents?.find((candidate) => candidate.id === agentId) as
    | { identity?: { avatar?: string; avatarUrl?: string } }
    | undefined;
  const identity = agent?.identity;
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

type ChatStartupMetadataHandler = (params: {
  client: GatewayBrowserClient;
  agentId: string | null | undefined;
  metadata: ChatMetadataResult | undefined;
}) => void | Promise<void>;

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

export async function refreshChatModelAuthStatus(host: ChatPageHost, opts?: { refresh?: boolean }) {
  if (!host.client || !host.connected) {
    return;
  }
  const client = host.client;
  try {
    const result = await loadModelAuthStatus(client, opts);
    if (host.client !== client || !host.connected) {
      return;
    }
    host.modelAuthStatusResult = result;
    host.modelAuthStatusError = null;
  } catch (err) {
    if (host.client !== client || !host.connected) {
      return;
    }
    host.modelAuthStatusResult = { ts: 0, providers: [] };
    host.modelAuthStatusError = err instanceof Error ? err.message : String(err);
  }
}

export async function refreshChat(
  host: ChatPageHost,
  opts?: ChatRefreshOptions & {
    onStartupMetadata?: ChatStartupMetadataHandler;
  },
) {
  const refreshedSessionKey = host.sessionKey;
  const refreshedClient = host.client;
  const refreshedAgentId = resolveAgentIdForSession(host);
  const requestUpdate = () => host.requestUpdate?.();
  const previousSessionsResult = host.sessionsResult;
  const historyLoad = loadChatHistory(host as unknown as ChatState, {
    startup: opts?.startup === true,
  });
  const historyRefresh = historyLoad.finally(() => {
    if (opts?.scheduleScroll !== false) {
      scheduleChatScroll(host);
    }
    requestUpdate();
  });
  const sessionsRefresh = historyLoad.then((history) => {
    if (!history?.sessionInfo) {
      return;
    }
    if (areUiSessionKeysEquivalent(history.sessionInfo.key, refreshedSessionKey)) {
      host.selectedChatSessionArchived = history.sessionInfo.archived === true;
    }
    const reconciled = host.sessions.reconcile(history.sessionInfo, history.defaults, {
      resultAgentId: host.sessionsResultAgentId ?? refreshedAgentId,
      selectedGlobalAgentId: refreshedAgentId,
      showArchived: host.sessionsShowArchived,
    });
    const sessionsResult = reconciled ? host.sessions.state.result : host.sessionsResult;
    if (reconciled) {
      host.sessionsResult = sessionsResult;
    }
    const sessionInfo = sessionsResult?.sessions.find(
      (row: GatewaySessionRow) =>
        areUiSessionKeysEquivalent(row.key, history.sessionInfo?.key) ||
        row.key === refreshedSessionKey,
    );
    if (!sessionInfo) {
      return;
    }
    const runReconciled = reconcileChatRunFromSessionRow(host, sessionInfo, {
      publishRunStatus: true,
    });
    if (!runReconciled) {
      reconcileChatRunFromCurrentSessionRow(host, { publishRunStatus: true });
    }
  });
  const startupMetadataRefresh =
    opts?.startup === true && opts.onStartupMetadata && refreshedClient
      ? historyLoad.then((history) => {
          if (
            host.client !== refreshedClient ||
            !host.connected ||
            host.sessionKey !== refreshedSessionKey ||
            resolveAgentIdForSession(host) !== refreshedAgentId
          ) {
            return;
          }
          return opts.onStartupMetadata?.({
            client: refreshedClient,
            agentId: refreshedAgentId,
            metadata: history?.metadata,
          });
        })
      : Promise.resolve();
  flushChatQueueAfterIdleSessionReconciliation(
    host,
    refreshedSessionKey,
    historyRefresh,
    sessionsRefresh,
    previousSessionsResult,
    () => void flushChatQueueForEvent(host),
  );
  const secondaryRefresh = Promise.allSettled([sessionsRefresh, startupMetadataRefresh]).finally(
    requestUpdate,
  );
  void historyRefresh;
  void secondaryRefresh;
  if (opts?.awaitHistory === true) {
    await historyRefresh;
    return;
  }
  await Promise.resolve();
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

function sessionMessageMatchesChat(
  state: ChatPageHost,
  event: NonNullable<ReturnType<typeof readSessionChangedEvent>>,
): boolean {
  return chatScopedEventSessionMatches(state, event.key, event.agentId ?? undefined);
}

function selectedGlobalEventAgentId(state: ChatPageHost, agentId: string | null): string {
  return agentId ? normalizeAgentId(agentId) : resolveUiDefaultAgentId(state);
}

function globalSessionEventMatchesChat(
  state: ChatPageHost,
  event: NonNullable<ReturnType<typeof readSessionChangedEvent>>,
): boolean {
  if (!isUiGlobalSessionKey(event.key)) {
    return true;
  }
  const selectedAgentId = isUiGlobalSessionKey(state.sessionKey)
    ? resolveUiSelectedGlobalAgentId(state)
    : resolveUiGlobalAliasAgentId(state, state.sessionKey);
  return selectedAgentId
    ? selectedGlobalEventAgentId(state, event.agentId) === selectedAgentId
    : true;
}

function reconcileSessionEvent(state: ChatPageHost, payload: unknown): SessionChangedResult {
  const selectedAgentId = resolveChatAgentId(state);
  const reconciled = state.sessions.reconcileChanged(payload, {
    resultAgentId: state.sessionsResultAgentId ?? selectedAgentId,
    selectedGlobalAgentId: selectedAgentId,
    showArchived: state.sessionsShowArchived,
  });
  if (reconciled.applied) {
    state.sessionsResult = state.sessions.state.result;
    state.sessionsResultAgentId = state.sessions.state.agentId;
    state.sessionsError = state.sessions.state.error;
    reconcileStaleChatRunAfterSessionStatePublication(state);
  }
  return reconciled;
}

function finishSessionMessageRunReconcile(
  state: ChatPageHost,
  sessionKey: string,
  runId: string | null,
  row: SessionChangedResult["row"] | undefined,
): boolean {
  const cleared = row
    ? reconcileChatRunFromSessionRow(state, row, { publishRunStatus: true })
    : reconcileChatRunFromCurrentSessionRow(state, { publishRunStatus: true });
  if (!cleared) {
    return false;
  }
  clearPendingQueueItemsForRun(state, runId ?? undefined);
  void loadChatHistory(state)
    .finally(() => {
      if (!areUiSessionKeysEquivalent(state.sessionKey, sessionKey)) {
        return;
      }
      void flushChatQueueForEvent(state);
      state.requestUpdate?.();
    })
    .catch(() => undefined);
  return true;
}

function handleSessionMessageEvent(state: ChatPageHost, payload: unknown) {
  const event = readSessionChangedEvent(payload);
  if (!event || !globalSessionEventMatchesChat(state, event)) {
    return;
  }
  const matchesChat = sessionMessageMatchesChat(state, event);
  if (matchesChat && event.archived !== null) {
    state.selectedChatSessionArchived = event.archived;
  }
  const runIdBeforeApply = state.chatRunId;
  const result = reconcileSessionEvent(state, payload);
  if (runIdBeforeApply && matchesChat) {
    const runId = event.clientRunId ?? event.runId ?? runIdBeforeApply;
    state.pendingSessionMessageReloadSessionKey = event.key;
    if (event.hasActiveRun === true) {
      return;
    }
    if (finishSessionMessageRunReconcile(state, event.key, runId, result.row)) {
      state.pendingSessionMessageReloadSessionKey = null;
      return;
    }
    void refreshCurrentChatSessionList(state).then(() => {
      if (!state.pendingSessionMessageReloadSessionKey || state.chatRunId !== runIdBeforeApply) {
        return;
      }
      if (
        finishSessionMessageRunReconcile(
          state,
          state.pendingSessionMessageReloadSessionKey,
          runId,
          undefined,
        )
      ) {
        state.pendingSessionMessageReloadSessionKey = null;
      }
    });
    return;
  }
  if (matchesChat) {
    state.pendingSessionMessageReloadSessionKey = null;
    void loadChatHistory(state).finally(() => state.requestUpdate?.());
  }
}

function replayPendingSessionMessageReload(
  state: ChatPageHost,
  payload: ChatEventPayload | undefined,
) {
  const pendingSessionKey = state.pendingSessionMessageReloadSessionKey;
  const payloadSessionKey = payload?.sessionKey?.trim();
  if (
    !pendingSessionKey ||
    !payloadSessionKey ||
    !areUiSessionKeysEquivalent(pendingSessionKey, payloadSessionKey) ||
    !areUiSessionKeysEquivalent(payloadSessionKey, state.sessionKey) ||
    state.chatRunId
  ) {
    return;
  }
  state.pendingSessionMessageReloadSessionKey = null;
  void loadChatHistory(state).finally(() => state.requestUpdate?.());
}

function handleSessionsChangedEvent(state: ChatPageHost, payload: unknown) {
  const runIdBeforeApply = state.chatRunId;
  const event = readSessionChangedEvent(payload);
  if (
    event &&
    globalSessionEventMatchesChat(state, event) &&
    sessionMessageMatchesChat(state, event) &&
    event.archived !== null
  ) {
    state.selectedChatSessionArchived = event.archived;
  }
  const result = reconcileSessionEvent(state, payload);
  if (
    result.applied &&
    event &&
    runIdBeforeApply &&
    sessionMessageMatchesChat(state, event) &&
    finishSessionMessageRunReconcile(
      state,
      event.key,
      event.clientRunId ?? event.runId ?? runIdBeforeApply,
      result.row,
    )
  ) {
    return;
  }
  if (!result.applied && event?.isChatTurn !== true) {
    void refreshCurrentChatSessionList(state);
  }
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
  context: ApplicationContext,
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
    assistantName: appConfig.assistantIdentity.name,
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
    modelAuthStatusResult: null,
    modelAuthStatusError: null,
    sessionsResult: null,
    sessionsResultAgentId: null,
    sessionsLoading: false,
    sessionsError: null,
    sessionsShowArchived: false,
    selectedChatSessionArchived: false,
    agentsList: context.agents.state.agentsList,
    agentsSelectedId: context.agentSelection.state.selectedId,
    onAgentsList: (agentsList: AgentsListResult, client: GatewayBrowserClient) => {
      context.agents.adoptList(agentsList, client);
    },
    refreshSessionsAfterChat: new Map<string, { sessionKey: string; agentId?: string }>(),
    pendingAbort: null,
    pendingSessionMessageReloadSessionKey: null,
    chatSubmitGuards: new Map<string, Promise<void>>(),
    chatSendTimingsByRun: new Map<string, ChatSendTimingEntry>(),
    chatQueue: [] as ChatQueueItem[],
    chatQueueBySession: {} as Record<string, ChatQueueItem[]>,
    chatMessagesBySession: new Map<string, unknown[]>(),
    eventLogBuffer: [] as unknown[],
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
    ...createInitialChatRealtimeState(),
    requestUpdate,
    sessionWorkspaceState: undefined,
    sessionWorkspaceOpenRequest: undefined,
    querySelector: page.querySelector.bind(page),
  } as unknown as ChatPageHost;
  Object.defineProperty(state, "updateComplete", {
    configurable: true,
    enumerable: false,
    get: () => page.updateComplete,
  });

  state.resetToolStream = () => resetToolStream(state as never);
  state.onModelChanged = () => undefined;
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
    state.settings = patchSettings({
      chatShowThinking: next.chatShowThinking,
      chatShowToolCalls: next.chatShowToolCalls,
      chatPersistCommentary: next.chatPersistCommentary,
      chatAutoScroll: next.chatAutoScroll,
      splitRatio: next.splitRatio,
    });
    state.splitRatio = state.settings.splitRatio;
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
  attachChatRealtimeActions(state);
  state.loadAssistantIdentity = async () => {
    await loadPageAssistantIdentity(state);
  };
  state.handleSendChat = (messageOverride, options) =>
    handleSendChat(state, messageOverride, options as never);
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
    replayPendingSessionMessageReload(state, event.payload as ChatEventPayload | undefined);
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
  if (event.event === "session.message") {
    handleSessionMessageEvent(state, event.payload);
    requestPageUpdate(state);
    return;
  }
  if (event.event === "sessions.changed") {
    handleSessionsChangedEvent(state, event.payload);
    requestPageUpdate(state);
  }
}

function requestPageUpdate(state: ChatPageHost) {
  state.requestUpdate?.();
}

export class ChatStateController<TState extends ChatPageHost> implements ReactiveController {
  private readonly composerPersistence: ChatComposerPersistenceController;
  private stateValue: TState | undefined;
  private previousChatLoading = false;
  private previousChatMessages: unknown[] = [];
  private previousChatToolMessages: Record<string, unknown>[] = [];
  private previousChatStream: string | null = null;
  private previousRealtimeConversation: ChatPageHost["realtimeTalkConversation"] = [];
  private scrollAfterUpdate = false;
  private forceScrollAfterUpdate = false;
  private pendingCreatedSessionComposer: PendingCreatedSessionComposer | null = null;
  private readonly cleanups: Array<() => void> = [];

  constructor(private readonly host: ReactiveControllerHost) {
    host.addController(this);
    this.composerPersistence = new ChatComposerPersistenceController(host, () => this.stateValue);
  }

  get state(): TState | undefined {
    return this.stateValue;
  }

  attach(state: TState) {
    this.stateValue = state;
    this.previousChatLoading = state.chatLoading;
    this.previousChatMessages = state.chatMessages;
    this.previousChatToolMessages = state.chatToolMessages;
    this.previousChatStream = state.chatStream;
    this.previousRealtimeConversation = state.realtimeTalkConversation;
    state.requestUpdate = this.requestUpdate;
    const sendChat = state.handleSendChat;
    state.handleSendChat = async (messageOverride, options) => {
      const pending = sendChat(messageOverride, options);
      this.requestUpdate();
      try {
        await pending;
      } finally {
        this.requestUpdate();
      }
    };
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
    this.composerPersistence.persistChangedState();
    this.captureRenderLifecycleChanges();
    this.host.requestUpdate();
  };

  private captureRenderLifecycleChanges() {
    const state = this.stateValue;
    if (!state) {
      return;
    }
    const messagesChanged =
      this.previousChatMessages !== state.chatMessages ||
      this.previousChatToolMessages !== state.chatToolMessages ||
      this.previousRealtimeConversation !== state.realtimeTalkConversation;
    const streamChanged = this.previousChatStream !== state.chatStream;
    const loadingChanged = this.previousChatLoading !== state.chatLoading;
    const loadFinished = this.previousChatLoading && !state.chatLoading;
    const streamStarted = this.previousChatStream == null && typeof state.chatStream === "string";
    this.previousChatLoading = state.chatLoading;
    this.previousChatMessages = state.chatMessages;
    this.previousChatToolMessages = state.chatToolMessages;
    this.previousChatStream = state.chatStream;
    this.previousRealtimeConversation = state.realtimeTalkConversation;
    if (!messagesChanged && !streamChanged && !loadingChanged) {
      return;
    }
    this.scrollAfterUpdate = true;
    this.forceScrollAfterUpdate ||= loadFinished || streamStarted || !state.chatHasAutoScrolled;
  }

  hostUpdated() {
    if (!this.scrollAfterUpdate) {
      return;
    }
    const state = this.stateValue;
    const force = this.forceScrollAfterUpdate;
    this.scrollAfterUpdate = false;
    this.forceScrollAfterUpdate = false;
    if (!state || state.chatManualRefreshInFlight) {
      return;
    }
    scheduleChatScroll(state, force);
  }

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

  private stopChatEffects() {
    while (this.cleanups.length > 0) {
      this.cleanups.pop()?.();
    }
    const state = this.stateValue;
    if (state) {
      clearSessionWorkspaceTimers(state);
    }
    state?.realtimeTalkSession?.stop();
    if (state) {
      state.realtimeTalkSession = null;
      state.resetToolStream?.();
    }
  }

  hostDisconnected() {
    this.stopChatEffects();
    this.stateValue = undefined;
    this.scrollAfterUpdate = false;
    this.forceScrollAfterUpdate = false;
    this.pendingCreatedSessionComposer = null;
  }
}
