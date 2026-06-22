// Control UI module implements app gateway behavior.
import { ConnectErrorDetailCodes } from "../../../packages/gateway-protocol/src/connect-error-details.js";
import {
  GATEWAY_EVENT_UPDATE_AVAILABLE,
  type GatewayUpdateAvailableEventPayload,
} from "../../../src/gateway/events.js";
import type { EventLogEntry } from "../api/event-log.ts";
import { appRouter, getVisibleRouteId, routeLoadContext, type RouteId } from "../app-routes.ts";
import type { SettingsHost } from "../app/app-host.ts";
import {
  areUiSessionKeysEquivalent,
  buildAgentMainSessionKey,
  isUiGlobalSessionKey,
  normalizeAgentId,
  parseAgentSessionKey,
  resolveUiDefaultAgentId,
  resolveUiGlobalAliasAgentId,
  resolveUiSelectedGlobalAgentId,
} from "../lib/session-key.ts";
import { loadAgents, type AgentsState } from "../pages/agents/data.ts";
import {
  loadChatComposerSnapshot,
  restoreChatComposerState,
} from "../pages/chat/composer-persistence.ts";
import {
  clearPendingQueueItemsForRun,
  createChatSessionsLoadOverrides,
  flushChatQueueForEvent,
  hasReconnectableQueuedChatSends,
  markQueuedChatSendsWaitingForReconnect,
  recordChatSendServerTiming,
  recordFirstAssistantChatTiming,
  refreshChat,
  refreshChatAvatar,
  scopedAgentListParamsForRefreshTarget,
  retryReconnectableQueuedChatSends,
  scopedAgentListParamsForSession,
  scopedAgentParamsForSession,
} from "../pages/chat/data.ts";
import { shouldReloadHistoryForFinalEvent } from "../pages/chat/event-reload.ts";
import {
  loadChatHistory,
  handleChatEvent,
  type ChatEventPayload,
  type ChatState,
} from "../pages/chat/gateway.ts";
import { setLastActiveSessionKey } from "../pages/chat/last-active-session.ts";
import { reconcileChatRunLifecycle } from "../pages/chat/run-lifecycle.ts";
import { scheduleChatScroll } from "../pages/chat/scroll.ts";
import { parseChatSideResult, type ChatSideResult } from "../pages/chat/side-result.ts";
import type { ChatQueueItem, ChatSessionRefreshTarget } from "../pages/chat/types.ts";
import { loadDevices, type DevicesState } from "../pages/nodes/devices.ts";
import {
  applySessionsChangedEvent,
  loadSessions,
  subscribeSessions,
  syncSelectedSessionMessageSubscription,
  type SessionsState,
} from "../pages/sessions/data.ts";
import { applySettings, syncUrlWithSessionKey } from "./app-settings.ts";
import {
  handleAgentEvent,
  handleSessionOperationEvent,
  resetToolStream,
  type AgentEventPayload,
  type SessionOperationEventPayload,
} from "./app-tool-stream.ts";
import { formatConnectError } from "./connect-error.ts";
import {
  recordControlUiConnectTiming,
  recordControlUiRpcTiming,
} from "./control-ui-performance.ts";
import {
  loadAssistantIdentity,
  type AssistantIdentityState,
} from "./controllers/assistant-identity.ts";
import { loadControlUiBootstrapConfig } from "./controllers/control-ui-bootstrap.ts";
import type { ExecApprovalRequest } from "./controllers/exec-approval.ts";
import {
  clearResolvedExecApprovalPrompt,
  enqueueExecApprovalPrompt,
  parseExecApprovalRequested,
  parseExecApprovalResolved,
  parsePluginApprovalRequested,
  pruneExecApprovalQueue,
} from "./controllers/exec-approval.ts";
import { loadHealthState, type HealthState } from "./controllers/health.ts";
import { loadModelAuthStatusState } from "./controllers/model-auth-status.ts";
import {
  resolveGatewayErrorDetailCode,
  type GatewayEventFrame,
  type GatewayHelloOk,
} from "./gateway.ts";
import { GatewayBrowserClient } from "./gateway.ts";
import type { UiSettings } from "./storage.ts";
import type {
  AgentsListResult,
  PresenceEntry,
  HealthSummary,
  StatusSummary,
  UpdateAvailable,
} from "./types.ts";

function isGenericBrowserFetchFailure(message: string): boolean {
  return /^(?:typeerror:\s*)?(?:fetch failed|failed to fetch)$/i.test(message.trim());
}

type GatewayHost = {
  settings: UiSettings;
  password: string;
  clientInstanceId: string;
  client: GatewayBrowserClient | null;
  connected: boolean;
  hello: GatewayHelloOk | null;
  lastError: string | null;
  lastErrorCode: string | null;
  chatError?: string | null;
  onboarding?: boolean;
  eventLogBuffer: EventLogEntry[];
  eventLog: EventLogEntry[];
  presenceEntries: PresenceEntry[];
  presenceError: string | null;
  presenceStatus: StatusSummary | null;
  agentsLoading: boolean;
  agentsList: AgentsListResult | null;
  agentsError: string | null;
  healthLoading: boolean;
  healthResult: HealthSummary | null;
  healthError: string | null;
  debugHealth: HealthSummary | null;
  assistantName: string;
  assistantAvatar: string | null;
  assistantAgentId: string | null;
  serverVersion: string | null;
  pendingUpdateExpectedVersion: string | null;
  pendingUpdateHandoff: boolean;
  updateStatusBanner: { tone: "danger" | "warn" | "info"; text: string } | null;
  sessionKey: string;
  sessionsShowArchived: boolean;
  chatRunId: string | null;
  pendingAbort?: { runId?: string | null; sessionKey: string; agentId?: string } | null;
  refreshSessionsAfterChat: Map<string, ChatSessionRefreshTarget>;
  sessionsLoading?: boolean;
  chatMessage: string;
  chatQueue: ChatQueueItem[];
  chatComposerProvisionalRestore?: {
    sessionKey: string;
    chatMessage: string;
    chatQueue: ChatQueueItem[];
  } | null;
  execApprovalQueue: ExecApprovalRequest[];
  execApprovalBusy: boolean;
  execApprovalError: string | null;
  updateAvailable: UpdateAvailable | null;
  currentSessionId?: string | null;
  reconnectResumeSessionId?: string | null;
  reconcileWebPushState?: () => Promise<void> | void;
  realtimeTalkOptionsOpen?: boolean;
  fetchRealtimeTalkCatalog?: () => Promise<void>;
  sessionsChangedReloadTimer?: number | ReturnType<typeof globalThis.setTimeout> | null;
  controlUiBootstrapReady?: Promise<void> | null;
};

type GatewayHostWithDeferredSessionMessageReload = GatewayHost & {
  pendingSessionMessageReloadSessionKey?: string | null;
};

type SessionDefaultsSnapshot = {
  defaultAgentId?: string;
  mainKey?: string;
  mainSessionKey?: string;
  scope?: string;
};

type GatewayHostWithShutdownMessage = GatewayHost & {
  pendingShutdownMessage?: string | null;
  resumeChatQueueAfterReconnect?: boolean;
};

type GatewayHostWithSideResults = GatewayHost & {
  chatSideResult?: ChatSideResult | null;
  chatSideResultTerminalRuns?: Set<string>;
};

const SESSIONS_CHANGED_RELOAD_DEBOUNCE_MS = 5_000;
const DEFERRED_SESSION_MESSAGE_REPLAY_POLL_MS = 250;
const DEFERRED_SESSION_MESSAGE_REPLAY_TIMEOUT_MS = 10_000;
const UPDATE_RESTART_VERIFICATION_POLL_MS = 250;
const UPDATE_RESTART_VERIFICATION_TIMEOUT_MS = 10_000;
const UPDATE_HANDOFF_POLL_MS = 1_000;
const UPDATE_HANDOFF_TIMEOUT_MS = 35 * 60_000;
const UPDATE_HANDOFF_STARTED_REASON = "managed-service-handoff-started";
const UPDATE_RESTART_HEALTH_PENDING_REASON = "restart-health-pending";
const PENDING_UPDATE_HANDOFF_REASONS = new Set([
  UPDATE_HANDOFF_STARTED_REASON,
  UPDATE_RESTART_HEALTH_PENDING_REASON,
]);

function enqueueApprovalRequest(host: GatewayHost, entry: ExecApprovalRequest | null) {
  if (!entry) {
    return;
  }
  enqueueExecApprovalPrompt(host, entry);
}

function removeResolvedApprovalRequest(host: GatewayHost, payload: unknown) {
  const resolved = parseExecApprovalResolved(payload);
  if (resolved) {
    clearResolvedExecApprovalPrompt(host, resolved.id);
  }
}

function isTerminalChatState(
  state: ChatEventPayload["state"] | ReturnType<typeof handleChatEvent> | null | undefined,
): state is "final" | "aborted" | "error" {
  return state === "final" || state === "aborted" || state === "error";
}

function isChatTurnSessionChangedPayload(payload: unknown): boolean {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return false;
  }
  const record = payload as { phase?: unknown; reason?: unknown };
  return (
    record.phase === "start" ||
    record.phase === "message" ||
    record.phase === "end" ||
    record.phase === "error" ||
    record.reason === "send" ||
    record.reason === "steer"
  );
}

function clearSessionsChangedReloadTimer(host: GatewayHost) {
  if (host.sessionsChangedReloadTimer == null) {
    return;
  }
  globalThis.clearTimeout(host.sessionsChangedReloadTimer);
  host.sessionsChangedReloadTimer = null;
}

function shouldRunDeferredSessionsReload(host: GatewayHost): boolean {
  return host.connected && Boolean(host.client) && getVisibleRouteId() !== "chat";
}

function scheduleSessionsChangedReload(host: GatewayHost) {
  clearSessionsChangedReloadTimer(host);
  host.sessionsChangedReloadTimer = globalThis.setTimeout(() => {
    host.sessionsChangedReloadTimer = null;
    if (!shouldRunDeferredSessionsReload(host)) {
      return;
    }
    void loadSessions(host as unknown as SessionsState);
  }, SESSIONS_CHANGED_RELOAD_DEBOUNCE_MS);
}

type ConnectGatewayOptions = {
  reason?: "initial" | "seq-gap";
};

type UpdateRestartStatusResponse = {
  sentinel?: {
    kind?: string;
    status?: string;
    stats?: {
      reason?: string | null;
      after?: { version?: string | null } | null;
    } | null;
  } | null;
};

function resolveUpdateVerificationBanner(params: {
  expectedVersion: string;
  actualVersion: string | null;
}): { tone: "danger"; text: string } {
  const actualSuffix = params.actualVersion
    ? ` Expected v${params.expectedVersion}, running v${params.actualVersion}.`
    : "";
  return {
    tone: "danger",
    text: `Update installed but running version did not change — restart may have been blocked.${actualSuffix}`,
  };
}

function resolvePostRestartUpdateBanner(reason: string | null | undefined): {
  tone: "danger";
  text: string;
} {
  const normalizedReason = reason?.trim() || "restart-unhealthy";
  const guidance =
    normalizedReason === "restart-unhealthy"
      ? "The replacement process never became healthy and the previous process stayed up."
      : "Check the gateway logs for the replacement failure.";
  return {
    tone: "danger",
    text: `Update error: ${normalizedReason}. ${guidance}`,
  };
}

function resolvePendingUpdateHandoffTimeoutBanner(): {
  tone: "danger";
  text: string;
} {
  return {
    tone: "danger",
    text: "Update handoff started, but completion was not reported after reconnect. Run `openclaw update status` for the final result.",
  };
}

function isPendingUpdateHandoffSentinel(
  sentinel: UpdateRestartStatusResponse["sentinel"],
): boolean {
  const reason = sentinel?.stats?.reason;
  return (
    sentinel?.kind === "update" &&
    sentinel.status === "skipped" &&
    typeof reason === "string" &&
    PENDING_UPDATE_HANDOFF_REASONS.has(reason)
  );
}

async function verifyPendingUpdateVersion(
  host: GatewayHost,
  client: GatewayBrowserClient,
): Promise<void> {
  const expectedVersion = host.pendingUpdateExpectedVersion?.trim();
  const pendingHandoff = host.pendingUpdateHandoff;
  if (!expectedVersion && !pendingHandoff) {
    return;
  }
  const deadline =
    Date.now() +
    (pendingHandoff ? UPDATE_HANDOFF_TIMEOUT_MS : UPDATE_RESTART_VERIFICATION_TIMEOUT_MS);
  const pollMs = pendingHandoff ? UPDATE_HANDOFF_POLL_MS : UPDATE_RESTART_VERIFICATION_POLL_MS;
  while (host.client === client && host.connected && Date.now() < deadline) {
    let response: UpdateRestartStatusResponse | null;
    try {
      response = await client.request<UpdateRestartStatusResponse>("update.status", {});
    } catch {
      response = null;
    }
    const sentinel = response?.sentinel;
    if (isPendingUpdateHandoffSentinel(sentinel)) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, pollMs);
      });
      continue;
    }
    if (sentinel?.kind === "update" && sentinel.status && sentinel.status !== "ok") {
      host.pendingUpdateExpectedVersion = null;
      host.pendingUpdateHandoff = false;
      host.updateStatusBanner = resolvePostRestartUpdateBanner(sentinel.stats?.reason ?? null);
      return;
    }
    const actualVersion = sentinel?.stats?.after?.version?.trim() || null;
    if (
      sentinel?.kind === "update" &&
      sentinel.status === "ok" &&
      !actualVersion &&
      !expectedVersion
    ) {
      host.pendingUpdateExpectedVersion = null;
      host.pendingUpdateHandoff = false;
      return;
    }
    if (sentinel?.kind === "update" && actualVersion) {
      host.pendingUpdateExpectedVersion = null;
      host.pendingUpdateHandoff = false;
      if (expectedVersion && actualVersion !== expectedVersion) {
        host.updateStatusBanner = resolveUpdateVerificationBanner({
          expectedVersion,
          actualVersion,
        });
      }
      return;
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, pollMs);
    });
  }
  if (host.client !== client || !host.connected) {
    return;
  }
  const currentVersion = host.hello?.server?.version?.trim() || null;
  host.pendingUpdateExpectedVersion = null;
  host.pendingUpdateHandoff = false;
  if (expectedVersion && currentVersion !== expectedVersion) {
    host.updateStatusBanner = resolveUpdateVerificationBanner({
      expectedVersion,
      actualVersion: currentVersion,
    });
  } else if (pendingHandoff) {
    host.updateStatusBanner = resolvePendingUpdateHandoffTimeoutBanner();
  }
}

export function resolveControlUiClientVersion(params: {
  gatewayUrl: string;
  serverVersion: string | null;
  pageUrl?: string;
}): string | undefined {
  const serverVersion = params.serverVersion?.trim();
  if (!serverVersion) {
    return undefined;
  }
  const pageUrl =
    params.pageUrl ?? (typeof window === "undefined" ? undefined : window.location.href);
  if (!pageUrl) {
    return undefined;
  }
  try {
    const page = new URL(pageUrl);
    const gateway = new URL(params.gatewayUrl, page);
    const allowedProtocols = new Set(["ws:", "wss:", "http:", "https:"]);
    if (!allowedProtocols.has(gateway.protocol) || !isSameControlUiVersionEndpoint(page, gateway)) {
      return undefined;
    }
    return serverVersion;
  } catch {
    return undefined;
  }
}

function isSameControlUiVersionEndpoint(page: URL, gateway: URL): boolean {
  if (gateway.host === page.host) {
    return true;
  }
  return (
    isLoopbackHostname(page.hostname) &&
    isLoopbackHostname(gateway.hostname) &&
    resolveUrlEffectivePort(page) === resolveUrlEffectivePort(gateway)
  );
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  return (
    normalized === "localhost" ||
    normalized === "::1" ||
    normalized === "0:0:0:0:0:0:0:1" ||
    normalized === "127.0.0.1" ||
    normalized.startsWith("127.")
  );
}

function resolveUrlEffectivePort(url: URL): string {
  if (url.port) {
    return url.port;
  }
  switch (url.protocol) {
    case "http:":
    case "ws:":
      return "80";
    case "https:":
    case "wss:":
      return "443";
    default:
      return "";
  }
}

function normalizeSessionKeyForDefaults(
  value: string | undefined,
  defaults: SessionDefaultsSnapshot,
): string {
  const raw = (value ?? "").trim();
  const mainSessionKey = defaults.mainSessionKey?.trim();
  if (!mainSessionKey) {
    return raw;
  }
  if (!raw) {
    return mainSessionKey;
  }
  const mainKey = defaults.mainKey?.trim() || "main";
  const defaultAgentId = defaults.defaultAgentId?.trim();
  const isAlias =
    raw === "main" ||
    raw === mainKey ||
    (defaultAgentId &&
      (raw === `agent:${defaultAgentId}:main` || raw === `agent:${defaultAgentId}:${mainKey}`));
  return isAlias ? mainSessionKey : raw;
}

function applySessionDefaults(host: GatewayHost, defaults?: SessionDefaultsSnapshot) {
  if (!defaults?.mainSessionKey) {
    return;
  }

  // Detect if user has already selected a specific session (not an alias like "main").
  // If normalization doesn't change the value, it's a user-selected session.
  const normalizedSessionKey = normalizeSessionKeyForDefaults(host.sessionKey, defaults);
  const isUserSelectedSession = normalizedSessionKey === host.sessionKey;

  if (isUserSelectedSession) {
    // User has selected a specific session; preserve their choice
    // Only normalize lastActiveSessionKey, don't override current sessionKey
    const resolvedLastActiveSessionKey = normalizeSessionKeyForDefaults(
      host.settings.lastActiveSessionKey,
      defaults,
    );
    if (resolvedLastActiveSessionKey !== host.settings.lastActiveSessionKey) {
      applySettings(host as unknown as Parameters<typeof applySettings>[0], {
        ...host.settings,
        lastActiveSessionKey: resolvedLastActiveSessionKey,
      });
    }
    return; // Keep user's session selection
  }
  const resolvedSessionKey = normalizeSessionKeyForDefaults(host.sessionKey, defaults);
  const resolvedSettingsSessionKey = normalizeSessionKeyForDefaults(
    host.settings.sessionKey,
    defaults,
  );
  const resolvedLastActiveSessionKey = normalizeSessionKeyForDefaults(
    host.settings.lastActiveSessionKey,
    defaults,
  );
  const nextSessionKey = resolvedSessionKey || resolvedSettingsSessionKey || host.sessionKey;
  const nextSettings = {
    ...host.settings,
    sessionKey: resolvedSettingsSessionKey || nextSessionKey,
    lastActiveSessionKey: resolvedLastActiveSessionKey || nextSessionKey,
  };
  const shouldUpdateSettings =
    nextSettings.sessionKey !== host.settings.sessionKey ||
    nextSettings.lastActiveSessionKey !== host.settings.lastActiveSessionKey;
  if (nextSessionKey !== host.sessionKey) {
    host.sessionKey = nextSessionKey;
  }
  if (shouldUpdateSettings) {
    applySettings(host as unknown as Parameters<typeof applySettings>[0], nextSettings);
  }
}

function resolveMainSessionFallback(host: GatewayHost): string {
  const snapshot = host.hello?.snapshot as
    | { sessionDefaults?: SessionDefaultsSnapshot }
    | undefined;
  const mainSessionKey = snapshot?.sessionDefaults?.mainSessionKey?.trim();
  if (mainSessionKey) {
    return mainSessionKey;
  }
  const configuredMainKey =
    snapshot?.sessionDefaults?.mainKey?.trim() || host.agentsList?.mainKey?.trim();
  if (configuredMainKey && parseAgentSessionKey(configuredMainKey)) {
    return configuredMainKey;
  }
  const defaultAgentId = host.agentsList?.defaultId?.trim() || "main";
  return buildAgentMainSessionKey({
    agentId: defaultAgentId,
    mainKey: configuredMainKey,
  });
}

function resolveDefaultAgentId(host: GatewayHost): string {
  return resolveUiDefaultAgentId(host);
}

function resolveFreshDefaultAgentId(host: GatewayHost): string | undefined {
  const snapshot = host.hello?.snapshot as
    | { sessionDefaults?: SessionDefaultsSnapshot }
    | undefined;
  const defaults = snapshot?.sessionDefaults;
  const defaultAgentId = defaults?.defaultAgentId?.trim();
  if (defaultAgentId) {
    return normalizeAgentId(defaultAgentId);
  }
  const parsedMainSession = parseAgentSessionKey(defaults?.mainSessionKey ?? "");
  return parsedMainSession ? normalizeAgentId(parsedMainSession.agentId) : undefined;
}

function resolveSelectedGlobalAgentId(host: GatewayHost): string {
  return resolveUiSelectedGlobalAgentId(host);
}

function resolveSelectedGlobalEventAgentId(
  host: GatewayHost,
  agentId: string | undefined | null,
): string {
  return agentId ? normalizeAgentId(agentId) : resolveDefaultAgentId(host);
}

function globalAgentScopeMatches(
  host: GatewayHost,
  sessionKey: string | undefined | null,
  agentId: string | undefined | null,
): boolean {
  if (!isUiGlobalSessionKey(sessionKey)) {
    return true;
  }
  const selectedAgentId = isUiGlobalSessionKey(host.sessionKey)
    ? resolveSelectedGlobalAgentId(host)
    : resolveUiGlobalAliasAgentId(host, host.sessionKey);
  if (!selectedAgentId) {
    return true;
  }
  return resolveSelectedGlobalEventAgentId(host, agentId) === selectedAgentId;
}

function sessionMessageMatchesHost(
  host: GatewayHost,
  sessionKey: string | undefined,
  agentId: string | undefined | null,
): boolean {
  if (!sessionKey) {
    return false;
  }
  if (areUiSessionKeysEquivalent(sessionKey, host.sessionKey)) {
    return true;
  }
  const hostAliasAgentId = resolveUiGlobalAliasAgentId(host, host.sessionKey);
  return Boolean(
    hostAliasAgentId &&
    isUiGlobalSessionKey(sessionKey) &&
    resolveSelectedGlobalEventAgentId(host, agentId) === hostAliasAgentId,
  );
}

function chatSideResultAgentScopeMatches(host: GatewayHost, sideResult: ChatSideResult): boolean {
  return globalAgentScopeMatches(host, sideResult.sessionKey, sideResult.agentId);
}

function fallbackUnconfiguredSessionSelection(host: GatewayHost): boolean {
  const parsed = parseAgentSessionKey(host.sessionKey);
  if (!parsed) {
    return false;
  }
  const configuredAgentIds = new Set(
    (host.agentsList?.agents ?? []).map((entry) => normalizeAgentId(entry.id)),
  );
  if (configuredAgentIds.size === 0 || configuredAgentIds.has(normalizeAgentId(parsed.agentId))) {
    return false;
  }
  const nextSessionKey = resolveMainSessionFallback(host);
  host.sessionKey = nextSessionKey;
  applySettings(host as unknown as Parameters<typeof applySettings>[0], {
    ...host.settings,
    sessionKey: nextSessionKey,
    lastActiveSessionKey: nextSessionKey,
  });
  syncUrlWithSessionKey(
    host as unknown as Parameters<typeof syncUrlWithSessionKey>[0],
    nextSessionKey,
    true,
  );
  return true;
}

function canRefreshActiveTabBeforeAgents(host: GatewayHost): boolean {
  if (getVisibleRouteId() !== "chat") {
    return false;
  }
  if (isUiGlobalSessionKey(host.sessionKey)) {
    const freshDefaultAgentId = resolveFreshDefaultAgentId(host);
    if (!freshDefaultAgentId) {
      return false;
    }
    const carriedAgentId = host.assistantAgentId
      ? normalizeAgentId(host.assistantAgentId)
      : undefined;
    if (carriedAgentId && carriedAgentId !== freshDefaultAgentId) {
      return false;
    }
    const cachedDefaultAgentId = host.agentsList?.defaultId
      ? normalizeAgentId(host.agentsList.defaultId)
      : undefined;
    return !cachedDefaultAgentId || cachedDefaultAgentId === freshDefaultAgentId;
  }
  const parsed = parseAgentSessionKey(host.sessionKey);
  if (!parsed) {
    return true;
  }
  return normalizeAgentId(parsed.agentId) === resolveFreshDefaultAgentId(host);
}

function normalizeStartupRefreshError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function chatQueueMatches(left: ChatQueueItem[], right: ChatQueueItem[]): boolean {
  if (left === right) {
    return true;
  }
  if (left.length !== right.length) {
    return false;
  }
  return left.every((item, index) => item === right[index]);
}

function prepareHelloScopedComposerRestore(host: GatewayHost) {
  const provisional = host.chatComposerProvisionalRestore;
  host.chatComposerProvisionalRestore = null;
  const snapshot = host.hello?.snapshot as
    | { sessionDefaults?: SessionDefaultsSnapshot }
    | undefined;
  const provisionalSessionKey = provisional
    ? normalizeSessionKeyForDefaults(provisional.sessionKey, snapshot?.sessionDefaults ?? {})
    : "";
  if (!provisional || !areUiSessionKeysEquivalent(provisionalSessionKey, host.sessionKey)) {
    return;
  }
  if (
    host.chatMessage !== provisional.chatMessage ||
    !chatQueueMatches(host.chatQueue, provisional.chatQueue)
  ) {
    return;
  }
  if (!loadChatComposerSnapshot(host, host.sessionKey)) {
    return;
  }
  // The pre-hello restore used fallback agent scope for offline recovery.
  // Once hello resolves the real scope, clear only an untouched provisional
  // draft so the scoped restore can replace it without clobbering user edits.
  host.chatMessage = "";
  host.chatQueue = [];
}

async function loadAgentsThenRefreshActiveTab(host: GatewayHost) {
  let initialRefreshError: Error | undefined;
  const refreshBeforeAgents = canRefreshActiveTabBeforeAgents(host);
  const agentsListBeforeStartup = host.agentsList;
  const initialRefresh = refreshBeforeAgents
    ? refreshStartupChat(host).catch((err: unknown) => {
        initialRefreshError = normalizeStartupRefreshError(err);
      })
    : Promise.resolve();
  let refreshAfterAgents = !refreshBeforeAgents;
  let agentsError: Error | undefined;
  await initialRefresh;
  if (refreshBeforeAgents && host.agentsList && host.agentsList !== agentsListBeforeStartup) {
    if (initialRefreshError) {
      throw initialRefreshError;
    }
    return;
  }
  try {
    await loadAgents(host as unknown as AgentsState);
    refreshAfterAgents = fallbackUnconfiguredSessionSelection(host) || refreshAfterAgents;
  } catch (err: unknown) {
    agentsError = normalizeStartupRefreshError(err);
  }
  if (refreshAfterAgents) {
    await appRouter.revalidate(routeLoadContext(host as unknown as SettingsHost));
  } else if (initialRefreshError) {
    throw initialRefreshError;
  }
  if (agentsError) {
    throw agentsError;
  }
}

async function refreshStartupChat(host: GatewayHost) {
  try {
    await refreshChat(host as unknown as Parameters<typeof refreshChat>[0], {
      awaitHistory: true,
      startup: true,
    });
    scheduleChatScroll(
      host as unknown as Parameters<typeof scheduleChatScroll>[0],
      !(host as { chatHasAutoScrolled?: boolean }).chatHasAutoScrolled,
    );
  } finally {
    void loadModelAuthStatusState(
      host as unknown as Parameters<typeof loadModelAuthStatusState>[0],
    ).catch(() => undefined);
  }
}

async function loadAgentsThenRefreshActiveTabForClient(
  host: GatewayHost,
  client: GatewayBrowserClient,
) {
  if (host.client !== client) {
    return;
  }
  await loadAgentsThenRefreshActiveTab(host);
}

function scheduleDeferredStartupWork(callback: () => void) {
  if (typeof queueMicrotask === "function") {
    queueMicrotask(callback);
    return;
  }
  void Promise.resolve().then(callback);
}

export function connectGateway(host: GatewayHost, options?: ConnectGatewayOptions) {
  const shutdownHost = host as GatewayHostWithShutdownMessage;
  const reconnectReason = options?.reason ?? "initial";
  shutdownHost.pendingShutdownMessage = null;
  shutdownHost.resumeChatQueueAfterReconnect = false;
  clearSessionsChangedReloadTimer(host);
  host.lastError = null;
  host.lastErrorCode = null;
  host.chatError = null;
  host.hello = null;
  host.connected = false;
  if (reconnectReason === "seq-gap") {
    host.execApprovalQueue = pruneExecApprovalQueue(host.execApprovalQueue);
    clearPendingQueueItemsForRun(
      host as unknown as Parameters<typeof clearPendingQueueItemsForRun>[0],
      host.chatRunId ?? undefined,
    );
    shutdownHost.resumeChatQueueAfterReconnect = true;
  } else {
    host.execApprovalQueue = pruneExecApprovalQueue(host.execApprovalQueue);
  }
  host.execApprovalError = null;

  const previousClient = host.client;
  const clientVersion = resolveControlUiClientVersion({
    gatewayUrl: host.settings.gatewayUrl,
    serverVersion: host.serverVersion,
  });
  const client = new GatewayBrowserClient({
    url: host.settings.gatewayUrl,
    token: host.settings.token.trim() ? host.settings.token : undefined,
    password: host.password.trim() ? host.password : undefined,
    clientName: "openclaw-control-ui",
    clientVersion,
    mode: "webchat",
    instanceId: host.clientInstanceId,
    onHello: (hello) => {
      if (host.client !== client) {
        return;
      }
      shutdownHost.pendingShutdownMessage = null;
      host.connected = true;
      host.lastError = null;
      host.lastErrorCode = null;
      host.chatError = null;
      host.hello = hello;
      if (host.realtimeTalkOptionsOpen) {
        void host.fetchRealtimeTalkCatalog?.();
      }
      applySnapshot(host, hello);
      prepareHelloScopedComposerRestore(host);
      restoreChatComposerState(host as unknown as Parameters<typeof restoreChatComposerState>[0], {
        preserveCurrent: true,
      });
      // Process any pending abort from before the disconnect.
      if (host.pendingAbort) {
        const abort = host.pendingAbort;
        host.pendingAbort = null;
        void host.client
          .request(
            "chat.abort",
            abort.runId
              ? {
                  sessionKey: abort.sessionKey,
                  ...scopedAgentParamsForSession(host, abort.sessionKey),
                  ...(abort.agentId ? { agentId: abort.agentId } : {}),
                  runId: abort.runId,
                }
              : {
                  sessionKey: abort.sessionKey,
                  ...scopedAgentParamsForSession(host, abort.sessionKey),
                  ...(abort.agentId ? { agentId: abort.agentId } : {}),
                },
          )
          .catch((err: unknown) => {
            // Log to console for diagnostics; user sees no feedback for a stale abort
            // since the run likely completed during the disconnect window anyway.
            console.warn("[openclaw] pending abort failed:", err);
          });
      }
      // Reset orphaned chat run state from before disconnect.
      // Any in-flight run's final event was lost during the disconnect window.
      const orphanedRunId = host.chatRunId;
      const hadOrphanedRun =
        Boolean(orphanedRunId) ||
        (host as unknown as { chatStream?: string | null }).chatStream != null;
      reconcileChatRunLifecycle(
        host as unknown as Parameters<typeof reconcileChatRunLifecycle>[0],
        {
          outcome: hadOrphanedRun ? "interrupted" : undefined,
          sessionStatus: "killed",
          runId: orphanedRunId,
          sessionKey: host.sessionKey,
          clearLocalRun: true,
          clearChatStream: true,
          clearToolStream: true,
          clearSideResultTerminalRuns: true,
          clearRunStatus: !hadOrphanedRun,
        },
      );
      const hasReconnectableChatSends = hasReconnectableQueuedChatSends(
        host as unknown as Parameters<typeof hasReconnectableQueuedChatSends>[0],
      );
      if (shutdownHost.resumeChatQueueAfterReconnect || hasReconnectableChatSends) {
        // The interrupted run will never emit its terminal event now that the
        // old client is gone, so resume any deferred commands after hello.
        shutdownHost.resumeChatQueueAfterReconnect = false;
        if (hasReconnectableChatSends) {
          void retryReconnectableQueuedChatSends(
            host as unknown as Parameters<typeof retryReconnectableQueuedChatSends>[0],
          );
        }
        void flushChatQueueForEvent(
          host as unknown as Parameters<typeof flushChatQueueForEvent>[0],
        );
      }
      void subscribeSessions(host as unknown as SessionsState);
      void syncSelectedSessionMessageSubscription(
        host as unknown as SessionsState & { sessionKey: string },
        { force: true },
      );
      void loadAgentsThenRefreshActiveTabForClient(host, client);
      scheduleDeferredStartupWork(() => {
        if (host.client !== client) {
          return;
        }
        void loadControlUiBootstrapConfig(
          host as unknown as Parameters<typeof loadControlUiBootstrapConfig>[0],
          { applyIdentity: false },
        );
        void loadAssistantIdentity(host as unknown as AssistantIdentityState);
        if (getVisibleRouteId() !== "chat") {
          void refreshChatAvatar(host as unknown as Parameters<typeof refreshChatAvatar>[0]);
        }
        void loadHealthState(host as unknown as HealthState);
        // Re-run push reconciliation now that the gateway client is available.
        void host.reconcileWebPushState?.();
        void verifyPendingUpdateVersion(host, client);
      });
    },
    onClose: ({ code, reason, error }) => {
      if (host.client !== client) {
        return;
      }
      host.connected = false;
      const currentSessionId =
        typeof host.currentSessionId === "string" ? host.currentSessionId.trim() : "";
      if (currentSessionId) {
        host.reconnectResumeSessionId = currentSessionId;
      }
      markQueuedChatSendsWaitingForReconnect(
        host as unknown as Parameters<typeof markQueuedChatSendsWaitingForReconnect>[0],
      );
      clearSessionsChangedReloadTimer(host);
      // Code 1012 = Service Restart (expected during config saves, don't show as error)
      host.lastErrorCode =
        resolveGatewayErrorDetailCode(error) ??
        (typeof error?.code === "string" ? error.code : null);
      if (code !== 1012) {
        if (error?.message) {
          host.lastError =
            host.lastErrorCode &&
            (host.lastErrorCode === ConnectErrorDetailCodes.PAIRING_REQUIRED ||
              isGenericBrowserFetchFailure(error.message))
              ? formatConnectError({
                  message: error.message,
                  details: error.details,
                  code: error.code,
                } as Parameters<typeof formatConnectError>[0])
              : error.message;
          return;
        }
        host.lastError =
          shutdownHost.pendingShutdownMessage ?? `disconnected (${code}): ${reason || "no reason"}`;
      } else {
        host.lastError = shutdownHost.pendingShutdownMessage ?? null;
        host.lastErrorCode = null;
      }
    },
    onEvent: (evt) => {
      if (host.client !== client) {
        return;
      }
      handleGatewayEvent(host, evt);
    },
    onRequestTiming: (timing) => {
      if (host.client !== client) {
        return;
      }
      recordControlUiRpcTiming(host, timing);
    },
    onConnectTiming: (timing) => {
      if (host.client !== client) {
        return;
      }
      recordControlUiConnectTiming(host, timing);
    },
    onGap: ({ expected, received }) => {
      if (host.client !== client) {
        return;
      }
      host.lastError = `event gap detected (expected seq ${expected}, got ${received}); reconnecting`;
      host.lastErrorCode = null;
      connectGateway(host, { reason: "seq-gap" });
    },
  });
  host.client = client;
  previousClient?.stop();
  client.start();
}

export function handleGatewayEvent(host: GatewayHost, evt: GatewayEventFrame) {
  try {
    handleGatewayEventUnsafe(host, evt);
  } catch (err) {
    console.error("[gateway] handleGatewayEvent error:", evt.event, err);
  }
}

function handleTerminalChatEvent(
  host: GatewayHost,
  payload: ChatEventPayload | undefined,
  state: ReturnType<typeof handleChatEvent>,
  activeRunIdBeforeEvent: string | null,
): boolean {
  if (state !== "final" && state !== "error" && state !== "aborted") {
    return false;
  }
  if (isEventForDifferentActiveRun(payload, activeRunIdBeforeEvent)) {
    return false;
  }
  // Check if tool events were seen before resetting (resetToolStream clears toolStreamOrder).
  const toolHost = host as unknown as Parameters<typeof resetToolStream>[0];
  const hadToolEvents = toolHost.toolStreamOrder.length > 0;
  const flushQueue = () =>
    void flushChatQueueForEvent(host as unknown as Parameters<typeof flushChatQueueForEvent>[0]);
  clearPendingQueueItemsForRun(
    host as unknown as Parameters<typeof clearPendingQueueItemsForRun>[0],
    payload?.runId,
  );
  const runId = payload?.runId;
  const refreshTarget = runId ? host.refreshSessionsAfterChat.get(runId) : undefined;
  if (runId && refreshTarget) {
    host.refreshSessionsAfterChat.delete(runId);
    if (state === "final") {
      void loadSessions(host as unknown as SessionsState, {
        ...createChatSessionsLoadOverrides(host),
        ...scopedAgentListParamsForRefreshTarget(host, refreshTarget),
      });
    }
  }
  // Reload history when tools were used only if the terminal event did not carry
  // a renderable assistant message. Source-reply finals already contain the UI
  // response; an immediate transcript reload replaces the optimistic user bubble
  // with the persisted copy and causes a visible disappear/reappear flicker.
  if (hadToolEvents && state === "final") {
    if (activeRunIdBeforeEvent && !shouldReloadHistoryForFinalEvent(payload)) {
      flushQueue();
      return false;
    }
    const completedRunId = runId ?? null;
    void loadChatHistory(host as unknown as ChatState).finally(() => {
      if (completedRunId && host.chatRunId && host.chatRunId !== completedRunId) {
        return;
      }
      resetToolStream(toolHost);
      flushQueue();
    });
    return true;
  }
  resetToolStream(toolHost);
  flushQueue();
  return false;
}

function isEventForDifferentActiveRun(
  payload: ChatEventPayload | undefined,
  activeRunId: string | null,
): boolean {
  return Boolean(activeRunId && payload && payload.runId !== activeRunId);
}

function handleChatGatewayEvent(host: GatewayHost, payload: ChatEventPayload | undefined) {
  if (payload?.sessionKey) {
    setLastActiveSessionKey(
      host as unknown as Parameters<typeof setLastActiveSessionKey>[0],
      payload.sessionKey,
    );
  }
  const sideResultHost = host as GatewayHostWithSideResults;
  const isTrackedSideResultTerminalEvent =
    isTerminalChatState(payload?.state) &&
    typeof payload?.runId === "string" &&
    sideResultHost.chatSideResultTerminalRuns?.has(payload.runId) === true;
  if (isTrackedSideResultTerminalEvent && payload?.runId) {
    sideResultHost.chatSideResultTerminalRuns?.delete(payload.runId);
    return;
  }
  const activeRunIdBeforeEvent = host.chatRunId;
  const state = handleChatEvent(host as unknown as ChatState, payload);
  recordFirstAssistantChatTiming(
    host as unknown as Parameters<typeof recordFirstAssistantChatTiming>[0],
    payload,
    state,
  );
  const terminalEventIsForDifferentActiveRun = isEventForDifferentActiveRun(
    payload,
    activeRunIdBeforeEvent,
  );
  const historyReloaded = handleTerminalChatEvent(host, payload, state, activeRunIdBeforeEvent);
  const deferredReloadHost = host as GatewayHostWithDeferredSessionMessageReload;
  const deferredSessionKey = deferredReloadHost.pendingSessionMessageReloadSessionKey?.trim();
  const payloadSessionKey = payload?.sessionKey?.trim();
  const finalEventNeedsHistoryReload =
    state === "final" && shouldReloadHistoryForFinalEvent(payload);
  const shouldResolveDeferredSessionMessageReload = Boolean(
    deferredSessionKey &&
    payloadSessionKey &&
    areUiSessionKeysEquivalent(deferredSessionKey, payloadSessionKey) &&
    isTerminalChatState(state) &&
    !terminalEventIsForDifferentActiveRun &&
    areUiSessionKeysEquivalent(payloadSessionKey, host.sessionKey) &&
    !host.chatRunId,
  );
  const shouldReplayDeferredSessionMessageReload =
    shouldResolveDeferredSessionMessageReload &&
    (state !== "final" || finalEventNeedsHistoryReload);
  if (shouldResolveDeferredSessionMessageReload) {
    deferredReloadHost.pendingSessionMessageReloadSessionKey = null;
  }
  if (finalEventNeedsHistoryReload && !historyReloaded && !terminalEventIsForDifferentActiveRun) {
    void loadChatHistory(host as unknown as ChatState);
    return;
  }
  if (shouldReplayDeferredSessionMessageReload && !historyReloaded) {
    void loadChatHistory(host as unknown as ChatState);
  }
}

function flushChatQueueAfterSessionRunReconcile(
  host: GatewayHost,
  result: ReturnType<typeof applySessionsChangedEvent>,
  payload: { clientRunId?: unknown; runId?: unknown; sessionKey?: unknown } | undefined,
  fallbackRunId?: string | null,
): boolean {
  const runId =
    typeof payload?.clientRunId === "string" && payload.clientRunId.trim()
      ? payload.clientRunId
      : typeof payload?.runId === "string" && payload.runId.trim()
        ? payload.runId
        : (fallbackRunId ?? undefined);
  clearPendingQueueItemsForRun(
    host as unknown as Parameters<typeof clearPendingQueueItemsForRun>[0],
    runId,
  );
  const flushQueue = () =>
    void flushChatQueueForEvent(host as unknown as Parameters<typeof flushChatQueueForEvent>[0]);
  const publishRunStatus = () => {
    if (!result.applied || !result.clearedChatRunStatus || host.chatRunId) {
      return;
    }
    reconcileChatRunLifecycle(host as unknown as Parameters<typeof reconcileChatRunLifecycle>[0], {
      outcome: result.clearedChatRunStatus.phase,
      runId: result.clearedChatRunStatus.runId,
      sessionKey: result.clearedChatRunStatus.sessionKey,
      clearIndicators: false,
    });
  };
  const deferredReloadHost = host as GatewayHostWithDeferredSessionMessageReload;
  const pendingSessionKey = deferredReloadHost.pendingSessionMessageReloadSessionKey?.trim();
  const eventSessionKey = typeof payload?.sessionKey === "string" ? payload.sessionKey.trim() : "";
  if (
    pendingSessionKey &&
    areUiSessionKeysEquivalent(pendingSessionKey, host.sessionKey) &&
    (!eventSessionKey || areUiSessionKeysEquivalent(eventSessionKey, pendingSessionKey))
  ) {
    deferredReloadHost.pendingSessionMessageReloadSessionKey = null;
    const reloadSessionKey = pendingSessionKey;
    void Promise.resolve(loadChatHistory(host as unknown as ChatState)).finally(() => {
      if (areUiSessionKeysEquivalent(host.sessionKey, reloadSessionKey)) {
        publishRunStatus();
        flushQueue();
      }
    });
    return true;
  }
  publishRunStatus();
  flushQueue();
  return false;
}

function handleSessionMessageGatewayEvent(
  host: GatewayHost,
  payload: { sessionKey?: string; agentId?: string; runId?: unknown } | undefined,
) {
  const deferredReloadHost = host as GatewayHostWithDeferredSessionMessageReload;
  const sessionKey = payload?.sessionKey?.trim();
  if (!globalAgentScopeMatches(host, sessionKey, payload?.agentId)) {
    return;
  }
  const sessionMatchesHost = sessionMessageMatchesHost(host, sessionKey, payload?.agentId);
  const runIdBeforeApply = host.chatRunId;
  const result = applySessionsChangedEvent(host as unknown as SessionsState, payload);
  if (result.applied && result.clearedChatRun) {
    if (sessionMatchesHost) {
      deferredReloadHost.pendingSessionMessageReloadSessionKey = sessionKey;
    }
    if (flushChatQueueAfterSessionRunReconcile(host, result, payload, runIdBeforeApply)) {
      return;
    }
  }
  if (!sessionKey || !sessionMatchesHost) {
    return;
  }
  // Skip history reload while a chat run is active. The chat event handler
  // manages streaming state and appends the final assistant message. Reloading
  // history mid-run races with the optimistic user-message update and resets
  // chatStream, which delays the user message card from appearing until the
  // first LLM delta arrives.
  if (host.chatRunId) {
    // Gateway confirms the run is still active (plugin hook window, etc.).
    // Skip reload — the pending chat terminal owns history reconciliation.
    if ((payload as Record<string, unknown> | null)?.hasActiveRun === true) {
      deferredReloadHost.pendingSessionMessageReloadSessionKey = sessionKey;
      return;
    }
    deferredReloadHost.pendingSessionMessageReloadSessionKey = sessionKey;
    const refreshStartedAt = Date.now();
    const runIdBeforeRefresh = host.chatRunId;
    void loadSessions(host as unknown as SessionsState, {
      ...createChatSessionsLoadOverrides(host),
      ...scopedAgentListParamsForSession(host, host.sessionKey),
      publishChatRunStatus: false,
    }).finally(() =>
      replayDeferredSessionMessageReloadAfterSessionsRefresh(
        host,
        sessionKey,
        payload?.agentId,
        refreshStartedAt,
        runIdBeforeRefresh,
      ),
    );
    return;
  }
  deferredReloadHost.pendingSessionMessageReloadSessionKey = null;
  void loadChatHistory(host as unknown as ChatState);
}

function replayDeferredSessionMessageReloadAfterSessionsRefresh(
  host: GatewayHost,
  sessionKey: string,
  agentId: string | undefined | null,
  startedAt: number,
  completedRunId?: string | null,
) {
  const deferredReloadHost = host as GatewayHostWithDeferredSessionMessageReload;
  if (
    !areUiSessionKeysEquivalent(
      deferredReloadHost.pendingSessionMessageReloadSessionKey?.trim() ?? "",
      sessionKey,
    ) ||
    !sessionMessageMatchesHost(host, sessionKey, agentId)
  ) {
    return;
  }
  if (host.chatRunId) {
    if (
      host.sessionsLoading === true &&
      Date.now() - startedAt < DEFERRED_SESSION_MESSAGE_REPLAY_TIMEOUT_MS
    ) {
      globalThis.setTimeout(
        () =>
          replayDeferredSessionMessageReloadAfterSessionsRefresh(
            host,
            sessionKey,
            agentId,
            startedAt,
            completedRunId,
          ),
        DEFERRED_SESSION_MESSAGE_REPLAY_POLL_MS,
      );
    }
    return;
  }
  const row = (host as unknown as SessionsState).sessionsResult?.sessions.find((session) =>
    areUiSessionKeysEquivalent(session.key, sessionKey),
  );
  flushChatQueueAfterSessionRunReconcile(
    host,
    {
      applied: true,
      change: "updated",
      clearedChatRun: true,
      ...(row
        ? {
            clearedChatRunStatus: {
              phase: row.status === "done" ? "done" : "interrupted",
              runId: completedRunId ?? null,
              sessionKey,
            },
          }
        : {}),
    },
    { sessionKey },
    completedRunId,
  );
}

function handleGatewayEventUnsafe(host: GatewayHost, evt: GatewayEventFrame) {
  host.eventLogBuffer = [
    { ts: Date.now(), event: evt.event, payload: evt.payload },
    ...host.eventLogBuffer,
  ].slice(0, 250);
  if (getVisibleRouteId() === "debug" || getVisibleRouteId() === "overview") {
    host.eventLog = host.eventLogBuffer;
  }

  if (evt.event === "agent" || evt.event === "session.tool") {
    if (host.onboarding) {
      return;
    }
    handleAgentEvent(
      host as unknown as Parameters<typeof handleAgentEvent>[0],
      evt.payload as AgentEventPayload | undefined,
    );
    return;
  }

  if (evt.event === "chat") {
    handleChatGatewayEvent(host, evt.payload as ChatEventPayload | undefined);
    return;
  }

  if (evt.event === "chat.send_timing") {
    recordChatSendServerTiming(
      host as unknown as Parameters<typeof recordChatSendServerTiming>[0],
      evt.payload,
    );
    return;
  }

  if (evt.event === "chat.side_result") {
    const sideResult = parseChatSideResult(evt.payload);
    if (
      !sideResult ||
      !sessionMessageMatchesHost(host, sideResult.sessionKey, sideResult.agentId) ||
      !chatSideResultAgentScopeMatches(host, sideResult)
    ) {
      return;
    }
    const sideResultHost = host as GatewayHostWithSideResults;
    sideResultHost.chatSideResult = sideResult;
    sideResultHost.chatSideResultTerminalRuns?.add(sideResult.runId);
    return;
  }

  if (evt.event === "session.message") {
    handleSessionMessageGatewayEvent(
      host,
      evt.payload as { sessionKey?: string; agentId?: string } | undefined,
    );
    return;
  }

  if (evt.event === "session.operation") {
    handleSessionOperationEvent(
      host as unknown as Parameters<typeof handleSessionOperationEvent>[0],
      evt.payload as SessionOperationEventPayload | undefined,
    );
    return;
  }

  if (evt.event === "presence") {
    const payload = evt.payload as { presence?: PresenceEntry[] } | undefined;
    if (payload?.presence && Array.isArray(payload.presence)) {
      host.presenceEntries = payload.presence;
      host.presenceError = null;
      host.presenceStatus = null;
    }
    return;
  }

  if (evt.event === "shutdown") {
    const payload = evt.payload as { reason?: unknown; restartExpectedMs?: unknown } | undefined;
    const reason =
      payload && typeof payload.reason === "string" && payload.reason.trim()
        ? payload.reason.trim()
        : "gateway stopping";
    const shutdownMessage =
      typeof payload?.restartExpectedMs === "number"
        ? `Restarting: ${reason}`
        : `Disconnected: ${reason}`;
    (host as GatewayHostWithShutdownMessage).pendingShutdownMessage = shutdownMessage;
    host.lastError = shutdownMessage;
    host.lastErrorCode = null;
    return;
  }

  if (evt.event === "sessions.changed") {
    const runIdBeforeApply = host.chatRunId;
    const result = applySessionsChangedEvent(host as unknown as SessionsState, evt.payload);
    if (result.applied) {
      if (result.clearedChatRun) {
        flushChatQueueAfterSessionRunReconcile(
          host,
          result,
          evt.payload as
            | { clientRunId?: unknown; runId?: unknown; sessionKey?: unknown }
            | undefined,
          runIdBeforeApply,
        );
      }
      return;
    }
    if (isChatTurnSessionChangedPayload(evt.payload)) {
      return;
    }
    scheduleSessionsChangedReload(host);
    return;
  }

  if (evt.event === "cron" && getVisibleRouteId() === "cron") {
    void appRouter.revalidate(routeLoadContext(host as unknown as SettingsHost), "cron");
  }

  if (evt.event === "device.pair.requested" || evt.event === "device.pair.resolved") {
    void loadDevices(host as unknown as DevicesState, { quiet: true });
  }

  if (evt.event === "exec.approval.requested") {
    enqueueApprovalRequest(host, parseExecApprovalRequested(evt.payload));
    return;
  }

  if (evt.event === "exec.approval.resolved") {
    removeResolvedApprovalRequest(host, evt.payload);
    return;
  }

  if (evt.event === "plugin.approval.requested") {
    enqueueApprovalRequest(host, parsePluginApprovalRequested(evt.payload));
    return;
  }

  if (evt.event === "plugin.approval.resolved") {
    removeResolvedApprovalRequest(host, evt.payload);
    return;
  }

  if (evt.event === GATEWAY_EVENT_UPDATE_AVAILABLE) {
    const payload = evt.payload as GatewayUpdateAvailableEventPayload | undefined;
    host.updateAvailable = payload?.updateAvailable ?? null;
  }
}

export function applySnapshot(host: GatewayHost, hello: GatewayHelloOk) {
  const snapshot = hello.snapshot as
    | {
        presence?: PresenceEntry[];
        health?: HealthSummary;
        sessionDefaults?: SessionDefaultsSnapshot;
        updateAvailable?: UpdateAvailable;
      }
    | undefined;
  if (snapshot?.presence && Array.isArray(snapshot.presence)) {
    host.presenceEntries = snapshot.presence;
  }
  if (snapshot?.health) {
    host.debugHealth = snapshot.health;
    host.healthResult = snapshot.health;
  }
  if (snapshot?.sessionDefaults) {
    applySessionDefaults(host, snapshot.sessionDefaults);
  }
  host.updateAvailable = snapshot?.updateAvailable ?? null;
}
