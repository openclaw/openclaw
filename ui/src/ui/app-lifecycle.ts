import type { RouteId } from "../app-routes.ts";
import { cancelActiveRouteTransition } from "../app/active-route.ts";
import type { SettingsAppHost, SettingsHost } from "../app/app-host.ts";
import { appRouter } from "../router/index.ts";
// Control UI module implements app lifecycle behavior.
import { connectGateway } from "./app-gateway.ts";
import {
  startNodesPolling,
  stopLogsPolling,
  stopNodesPolling,
  stopDebugPolling,
} from "./app-polling.ts";
import {
  observeTopbar,
  scheduleActivityScroll,
  scheduleChatScroll,
  scheduleLogsScroll,
} from "./app-scroll.ts";
import {
  applySettingsFromUrl,
  detachThemeListener,
  inferBasePath,
  syncRouteWithLocation,
  syncThemeWithSettings,
} from "./app-settings.ts";
import { persistChatComposerState, restoreChatComposerState } from "./chat/composer-persistence.ts";
import { startControlUiResponsivenessObserver } from "./control-ui-performance.ts";
import { loadControlUiBootstrapConfig } from "./controllers/control-ui-bootstrap.ts";
import { stopWorkboardLifecycleRefresh, stopWorkboardPolling } from "./controllers/workboard.ts";
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
  routeId: RouteId;
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
  controlUiRoutePaintSeq?: number;
  controlUiResponsivenessObserver?: { disconnect: () => void } | null;
  controlUiBootstrapReady?: Promise<void> | null;
  popStateHandler: () => void;
  topbarObserver: ResizeObserver | null;
};

export function handleConnected(host: LifecycleHost) {
  const connectGeneration = ++host.connectGeneration;
  host.basePath = inferBasePath();
  applySettingsFromUrl(host as unknown as Parameters<typeof applySettingsFromUrl>[0]);
  host.controlUiBootstrapReady = loadControlUiBootstrapConfig(
    host as unknown as Parameters<typeof loadControlUiBootstrapConfig>[0],
    { applyIdentity: false },
  );
  syncRouteWithLocation(host as unknown as Parameters<typeof syncRouteWithLocation>[0], true);
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
  window.addEventListener("popstate", host.popStateHandler);
  if (host.connectGeneration === connectGeneration) {
    connectGateway(host as unknown as Parameters<typeof connectGateway>[0]);
  }
  if (host.routeId === "nodes") {
    startNodesPolling(host as unknown as Parameters<typeof startNodesPolling>[0]);
  }
  void Promise.resolve(
    appRouter.getRoute(host.routeId)?.onEnter?.({
      host: host as unknown as SettingsHost,
      app: host as unknown as SettingsAppHost,
    }),
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

export function handleDisconnected(host: LifecycleHost) {
  host.connectGeneration += 1;
  host.controlUiRoutePaintSeq = (host.controlUiRoutePaintSeq ?? 0) + 1;
  cancelActiveRouteTransition(host as unknown as SettingsHost);
  flushPendingChatComposerPersistence(host);
  window.removeEventListener("popstate", host.popStateHandler);
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
  clearHostGlobalTimeout(host.sessionsChangedReloadTimer);
  host.sessionsChangedReloadTimer = null;
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

export function handleUpdated(host: LifecycleHost, changed: Map<PropertyKey, unknown>) {
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
  if (host.routeId === "chat" && host.chatManualRefreshInFlight) {
    return;
  }
  if (
    host.routeId === "chat" &&
    (changed.has("chatMessages") ||
      changed.has("chatToolMessages") ||
      changed.has("chatStream") ||
      changed.has("chatLoading") ||
      changed.has("realtimeTalkConversation") ||
      changed.has("routeId"))
  ) {
    const forcedByRoute = changed.has("routeId");
    const forcedByLoad =
      changed.has("chatLoading") && changed.get("chatLoading") === true && !host.chatLoading;
    // Detect streaming start: chatStream changed from null/undefined to a string value
    const previousStream = changed.get("chatStream") as string | null | undefined;
    const streamJustStarted =
      changed.has("chatStream") &&
      (previousStream === null || previousStream === undefined) &&
      typeof host.chatStream === "string";
    scheduleChatScroll(
      host as unknown as Parameters<typeof scheduleChatScroll>[0],
      forcedByRoute || forcedByLoad || streamJustStarted || !host.chatHasAutoScrolled,
    );
  }
  if (
    host.routeId === "logs" &&
    (changed.has("logsEntries") || changed.has("logsAutoFollow") || changed.has("routeId"))
  ) {
    if (host.logsAutoFollow && host.logsAtBottom) {
      scheduleLogsScroll(
        host as unknown as Parameters<typeof scheduleLogsScroll>[0],
        changed.has("routeId") || changed.has("logsAutoFollow"),
      );
    }
  }
  if (
    host.routeId === "activity" &&
    (changed.has("activityEntries") || changed.has("activityAutoFollow") || changed.has("routeId"))
  ) {
    if (host.activityAutoFollow && host.activityAtBottom) {
      scheduleActivityScroll(
        host as unknown as Parameters<typeof scheduleActivityScroll>[0],
        changed.has("routeId") || changed.has("activityAutoFollow"),
      );
    }
  }
}
