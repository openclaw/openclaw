import { appRouter, type ApplicationContext, startAppRouter } from "../app-routes.ts";
import { createBrowserHistory } from "../app/browser.ts";
import { stopLogsPolling } from "../pages/logs/polling.ts";
import { stopWorkboardLifecycleRefresh, stopWorkboardPolling } from "../pages/workboard/data.ts";
// Control UI module implements app lifecycle behavior.
import { connectGateway } from "./app-gateway.ts";
import { stopNodesPolling, stopDebugPolling } from "./app-polling.ts";
import { observeTopbar } from "./app-scroll.ts";
import {
  applySettingsFromUrl,
  detachThemeListener,
  inferBasePath,
  syncSessionWithLocation,
  syncThemeWithSettings,
} from "./app-settings.ts";
import { persistChatComposerState, restoreChatComposerState } from "./chat/composer-persistence.ts";
import { startControlUiResponsivenessObserver } from "./control-ui-performance.ts";
import { loadControlUiBootstrapConfig } from "./controllers/control-ui-bootstrap.ts";
import type { ChatQueueItem } from "./ui-types.ts";

const CHAT_COMPOSER_DRAFT_PERSIST_DELAY_MS = 200;

type PendingChatComposerPersistSnapshot = {
  sessionKey: string;
  chatMessage: string;
  chatQueue: ChatQueueItem[];
};

type LifecycleHost = {
  basePath: string;
  client?: { stop: () => void } | null;
  connectGeneration: number;
  connected?: boolean;
  assistantName: string;
  assistantAvatar: string | null;
  assistantAvatarSource?: string | null;
  assistantAvatarStatus?: "none" | "local" | "remote" | "data" | null;
  assistantAvatarReason?: string | null;
  assistantAgentId: string | null;
  serverVersion: string | null;
  localMediaPreviewRoots: string[];
  embedSandboxMode: "strict" | "scripts" | "trusted";
  allowExternalEmbedUrls: boolean;
  chatHasAutoScrolled: boolean;
  chatManualRefreshInFlight: boolean;
  settings?: { gatewayUrl?: string | null };
  sessionKey: string;
  chatMessage: string;
  chatQueue: ChatQueueItem[];
  chatComposerProvisionalRestore?: {
    sessionKey: string;
    chatMessage: string;
    chatQueue: ChatQueueItem[];
  } | null;
  chatComposerPersistTimer?: ReturnType<typeof globalThis.setTimeout> | number | null;
  chatComposerPersistSnapshot?: PendingChatComposerPersistSnapshot | null;
  pendingGatewayUrl?: string | null;
  realtimeTalkSession?: { stop: () => void } | null;
  realtimeTalkActive?: boolean;
  realtimeTalkStatus?: string;
  realtimeTalkDetail?: string | null;
  realtimeTalkTranscript?: string | null;
  realtimeTalkConversation?: unknown[];
  resetRealtimeTalkConversation?: () => void;
  chatLoading: boolean;
  chatMessages: unknown[];
  chatToolMessages: unknown[];
  chatStream: string | null;
  logsAutoFollow: boolean;
  logsAtBottom: boolean;
  logsEntries: unknown[];
  activityEntries: unknown[];
  activityAutoFollow: boolean;
  activityAtBottom: boolean;
  chatScrollFrame?: number | null;
  chatScrollTimeout?: number | null;
  logsScrollFrame?: number | null;
  activityScrollFrame?: number | null;
  sessionsChangedReloadTimer?: number | ReturnType<typeof globalThis.setTimeout> | null;
  controlUiResponsivenessObserver?: { disconnect: () => void } | null;
  controlUiBootstrapReady?: Promise<void> | null;
  topbarObserver: ResizeObserver | null;
  requestUpdate?: () => void;
};

export function handleConnected(host: LifecycleHost, application: ApplicationContext) {
  const connectGeneration = ++host.connectGeneration;
  host.basePath = inferBasePath();
  const history = createBrowserHistory();
  applySettingsFromUrl(host as unknown as Parameters<typeof applySettingsFromUrl>[0]);
  host.controlUiBootstrapReady = loadControlUiBootstrapConfig(
    host as unknown as Parameters<typeof loadControlUiBootstrapConfig>[0],
    { applyIdentity: false, skipWithoutAuthCandidate: true },
  );
  const hasPendingGatewaySwitch =
    typeof host.pendingGatewayUrl === "string" && host.pendingGatewayUrl.trim();
  if (!hasPendingGatewaySwitch && restoreChatComposerState(host, { preserveCurrent: true })) {
    host.chatComposerProvisionalRestore = {
      sessionKey: host.sessionKey,
      chatMessage: host.chatMessage,
      chatQueue: [...host.chatQueue],
    };
  } else {
    host.chatComposerProvisionalRestore = null;
  }
  syncThemeWithSettings(host as unknown as Parameters<typeof syncThemeWithSettings>[0]);
  if (host.connectGeneration === connectGeneration) {
    connectGateway(host as unknown as Parameters<typeof connectGateway>[0]);
  }
  void Promise.resolve(
    startAppRouter(history, host.basePath, application.routeLoadContext, () =>
      syncSessionWithLocation(host as unknown as Parameters<typeof syncSessionWithLocation>[0]),
    ),
  ).catch(() => undefined);
  host.controlUiResponsivenessObserver ??= startControlUiResponsivenessObserver(
    host as unknown as Parameters<typeof startControlUiResponsivenessObserver>[0],
  );
}

export function handleFirstUpdated(host: LifecycleHost) {
  observeTopbar(host as unknown as Parameters<typeof observeTopbar>[0]);
}

function cancelHostAnimationFrame(frame: number | null | undefined) {
  if (frame != null && typeof window.cancelAnimationFrame === "function") {
    window.cancelAnimationFrame(frame);
  }
}

function clearHostTimeout(timeout: number | null | undefined) {
  if (timeout != null && typeof window.clearTimeout === "function") {
    window.clearTimeout(timeout);
  }
}

function clearHostGlobalTimeout(
  timeout: number | ReturnType<typeof globalThis.setTimeout> | null | undefined,
) {
  if (timeout != null) {
    globalThis.clearTimeout(timeout);
  }
}

function clearPendingChatComposerPersistence(host: LifecycleHost) {
  clearHostGlobalTimeout(host.chatComposerPersistTimer);
  host.chatComposerPersistTimer = null;
  host.chatComposerPersistSnapshot = null;
}

function flushPendingChatComposerPersistence(host: LifecycleHost) {
  const snapshot = host.chatComposerPersistSnapshot;
  if (host.chatComposerPersistTimer == null || !snapshot) {
    clearPendingChatComposerPersistence(host);
    return;
  }
  clearPendingChatComposerPersistence(host);
  persistChatComposerState(
    {
      ...host,
      sessionKey: snapshot.sessionKey,
      chatMessage: snapshot.chatMessage,
      chatQueue: snapshot.chatQueue,
    },
    snapshot.sessionKey,
  );
}

function scheduleChatComposerDraftPersistence(host: LifecycleHost) {
  clearPendingChatComposerPersistence(host);
  host.chatComposerPersistSnapshot = {
    sessionKey: host.sessionKey,
    chatMessage: host.chatMessage,
    chatQueue: [...host.chatQueue],
  };
  host.chatComposerPersistTimer = globalThis.setTimeout(() => {
    flushPendingChatComposerPersistence(host);
  }, CHAT_COMPOSER_DRAFT_PERSIST_DELAY_MS);
}

function clearPendingSessionsChangedReload(host: LifecycleHost) {
  clearHostGlobalTimeout(host.sessionsChangedReloadTimer);
  host.sessionsChangedReloadTimer = null;
}

export function handleDisconnected(host: LifecycleHost) {
  host.connectGeneration += 1;
  appRouter.stop();
  flushPendingChatComposerPersistence(host);
  stopNodesPolling(host as unknown as Parameters<typeof stopNodesPolling>[0]);
  stopLogsPolling(host as unknown as Parameters<typeof stopLogsPolling>[0]);
  stopDebugPolling(host as unknown as Parameters<typeof stopDebugPolling>[0]);
  stopWorkboardPolling(host);
  stopWorkboardLifecycleRefresh(host);
  cancelHostAnimationFrame(host.chatScrollFrame);
  host.chatScrollFrame = null;
  cancelHostAnimationFrame(host.logsScrollFrame);
  host.logsScrollFrame = null;
  cancelHostAnimationFrame(host.activityScrollFrame);
  host.activityScrollFrame = null;
  clearHostTimeout(host.chatScrollTimeout);
  host.chatScrollTimeout = null;
  clearPendingSessionsChangedReload(host);
  host.realtimeTalkSession?.stop();
  host.realtimeTalkSession = null;
  host.realtimeTalkActive = false;
  host.realtimeTalkStatus = "idle";
  host.realtimeTalkDetail = null;
  host.realtimeTalkTranscript = null;
  host.resetRealtimeTalkConversation?.();
  host.client?.stop();
  host.client = null;
  host.connected = false;
  detachThemeListener(host as unknown as Parameters<typeof detachThemeListener>[0]);
  host.topbarObserver?.disconnect();
  host.topbarObserver = null;
  host.controlUiResponsivenessObserver?.disconnect();
  host.controlUiResponsivenessObserver = null;
}

export function handleUpdated(
  host: LifecycleHost,
  changed: Map<PropertyKey, unknown>,
  application: ApplicationContext,
) {
  if (changed.has("connected") && host.connected) {
    void appRouter.revalidate(application.routeLoadContext).catch(() => undefined);
  }
  if (changed.has("chatQueue")) {
    clearPendingChatComposerPersistence(host);
    persistChatComposerState(host);
  } else if (changed.has("sessionKey")) {
    flushPendingChatComposerPersistence(host);
    if (changed.has("chatMessage")) {
      persistChatComposerState(host);
    }
  } else if (changed.has("chatMessage")) {
    scheduleChatComposerDraftPersistence(host);
  }
  application.notifyStateChange(
    host as unknown as Parameters<ApplicationContext["notifyStateChange"]>[0],
    changed,
  );
}
