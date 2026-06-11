import { refreshChat } from "./app-chat.ts";
import { connectGateway } from "./app-gateway.ts";
import {
  startLogsPolling,
  startNodesPolling,
  stopLogsPolling,
  stopNodesPolling,
  startDebugPolling,
  stopDebugPolling,
  startKalshiDashboardPolling,
  shouldPollKalshiDashboard,
  stopKalshiDashboardPolling,
  startDashboardPolling,
  stopDashboardPolling,
} from "./app-polling.ts";
import { observeTopbar, scheduleChatScroll, scheduleLogsScroll } from "./app-scroll.ts";
import {
  applySettingsFromUrl,
  detachThemeListener,
  inferBasePath,
  syncTabWithLocation,
  syncThemeWithSettings,
} from "./app-settings.ts";
import { startControlUiResponsivenessObserver } from "./control-ui-performance.ts";
import { loadControlUiBootstrapConfig } from "./controllers/control-ui-bootstrap.ts";
import { installMobileViewportInsetObserver } from "./mobile-viewport.ts";
import type { Tab } from "./navigation.ts";

const MOBILE_RESUME_RECONCILE_DEBOUNCE_MS = 350;
const MOBILE_RESUME_RECONCILE_MIN_INTERVAL_MS = 1_000;

type LifecycleHost = {
  style: CSSStyleDeclaration;
  basePath: string;
  client?: { stop: () => void; connected?: boolean } | null;
  connectGeneration: number;
  connected?: boolean;
  connectionAttemptStarted?: boolean;
  tab: Tab;
  agentsPanel?: string;
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
  realtimeTalkSession?: { stop: () => void } | null;
  realtimeTalkActive?: boolean;
  realtimeTalkStatus?: string;
  realtimeTalkDetail?: string | null;
  realtimeTalkTranscript?: string | null;
  chatLoading: boolean;
  chatMessages: unknown[];
  chatToolMessages: unknown[];
  chatStream: string | null;
  logsAutoFollow: boolean;
  logsAtBottom: boolean;
  logsEntries: unknown[];
  chatScrollFrame?: number | null;
  chatScrollTimeout?: number | null;
  logsScrollFrame?: number | null;
  controlUiTabPaintSeq?: number;
  controlUiResponsivenessObserver?: { disconnect: () => void } | null;
  kalshiDashboardPollInterval?: number | null;
  dashboardPollInterval?: number | null;
  dashboardPollInFlight?: boolean;
  refreshActiveDashboardTab?: () => Promise<void> | void;
  popStateHandler: () => void;
  topbarObserver: ResizeObserver | null;
  mobileViewportCleanup?: (() => void) | null;
  mobileResumeCleanup?: (() => void) | null;
  requestUpdate?: () => void;
};

type MobileResumeState = {
  lastRunAtMs: number;
  timer: number | null;
  inFlight: boolean;
};

const mobileResumeStates = new WeakMap<object, MobileResumeState>();

function getMobileResumeState(host: LifecycleHost): MobileResumeState {
  let state = mobileResumeStates.get(host as object);
  if (!state) {
    state = { lastRunAtMs: 0, timer: null, inFlight: false };
    mobileResumeStates.set(host as object, state);
  }
  return state;
}

function clientAppearsConnected(host: LifecycleHost): boolean {
  if (!host.connected || !host.client) {
    return false;
  }
  return typeof host.client.connected === "boolean" ? host.client.connected : true;
}

async function reconcileAfterMobileResume(host: LifecycleHost) {
  const state = getMobileResumeState(host);
  if (state.inFlight) {
    return;
  }
  state.inFlight = true;
  state.lastRunAtMs = Date.now();
  try {
    if (!clientAppearsConnected(host)) {
      connectGateway(host as unknown as Parameters<typeof connectGateway>[0]);
      return;
    }
    if (host.tab !== "chat") {
      return;
    }
    await refreshChat(host as unknown as Parameters<typeof refreshChat>[0], {
      awaitHistory: true,
      scheduleScroll: false,
    });
    host.requestUpdate?.();
  } finally {
    state.inFlight = false;
  }
}

function scheduleMobileResumeReconcile(host: LifecycleHost) {
  if (typeof window === "undefined") {
    return;
  }
  if (typeof document !== "undefined" && document.visibilityState === "hidden") {
    return;
  }
  const state = getMobileResumeState(host);
  if (state.timer !== null) {
    window.clearTimeout(state.timer);
  }
  const elapsed = Date.now() - state.lastRunAtMs;
  const delay =
    elapsed >= MOBILE_RESUME_RECONCILE_MIN_INTERVAL_MS
      ? MOBILE_RESUME_RECONCILE_DEBOUNCE_MS
      : MOBILE_RESUME_RECONCILE_MIN_INTERVAL_MS - elapsed;
  state.timer = window.setTimeout(() => {
    state.timer = null;
    void reconcileAfterMobileResume(host);
  }, delay);
}

function installMobileResumeObserver(host: LifecycleHost) {
  if (typeof window === "undefined") {
    return;
  }
  host.mobileResumeCleanup?.();
  const schedule = () => scheduleMobileResumeReconcile(host);
  const scheduleWhenVisible = () => {
    if (typeof document !== "undefined" && document.visibilityState === "hidden") {
      return;
    }
    schedule();
  };
  window.addEventListener("pageshow", schedule);
  window.addEventListener("focus", scheduleWhenVisible);
  window.addEventListener("online", schedule);
  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", scheduleWhenVisible);
  }
  host.mobileResumeCleanup = () => {
    const state = getMobileResumeState(host);
    if (state.timer !== null) {
      window.clearTimeout(state.timer);
      state.timer = null;
    }
    window.removeEventListener("pageshow", schedule);
    window.removeEventListener("focus", scheduleWhenVisible);
    window.removeEventListener("online", schedule);
    if (typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", scheduleWhenVisible);
    }
    host.mobileResumeCleanup = null;
  };
}

export function handleConnected(host: LifecycleHost) {
  const connectGeneration = ++host.connectGeneration;
  host.connectionAttemptStarted = true;
  host.basePath = inferBasePath();
  applySettingsFromUrl(host as unknown as Parameters<typeof applySettingsFromUrl>[0]);
  const bootstrapReady = loadControlUiBootstrapConfig(host);
  syncTabWithLocation(host as unknown as Parameters<typeof syncTabWithLocation>[0], true);
  syncThemeWithSettings(host as unknown as Parameters<typeof syncThemeWithSettings>[0]);
  window.addEventListener("popstate", host.popStateHandler);
  installMobileResumeObserver(host);
  void bootstrapReady.finally(() => {
    if (host.connectGeneration !== connectGeneration) {
      return;
    }
    connectGateway(host as unknown as Parameters<typeof connectGateway>[0]);
  });
  startNodesPolling(host as unknown as Parameters<typeof startNodesPolling>[0]);
  if (host.tab === "logs") {
    startLogsPolling(host as unknown as Parameters<typeof startLogsPolling>[0]);
  }
  if (host.tab === "debug") {
    startDebugPolling(host as unknown as Parameters<typeof startDebugPolling>[0]);
  }
  if (shouldPollKalshiDashboard(host)) {
    startKalshiDashboardPolling(
      host as unknown as Parameters<typeof startKalshiDashboardPolling>[0],
    );
  }
  startDashboardPolling(host as unknown as Parameters<typeof startDashboardPolling>[0]);
  host.controlUiResponsivenessObserver ??= startControlUiResponsivenessObserver(
    host as unknown as Parameters<typeof startControlUiResponsivenessObserver>[0],
  );
}

export function handleFirstUpdated(host: LifecycleHost) {
  observeTopbar(host as unknown as Parameters<typeof observeTopbar>[0]);
  installMobileViewportInsetObserver(host);
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

export function handleDisconnected(host: LifecycleHost) {
  host.connectGeneration += 1;
  host.controlUiTabPaintSeq = (host.controlUiTabPaintSeq ?? 0) + 1;
  window.removeEventListener("popstate", host.popStateHandler);
  stopNodesPolling(host as unknown as Parameters<typeof stopNodesPolling>[0]);
  stopLogsPolling(host as unknown as Parameters<typeof stopLogsPolling>[0]);
  stopDebugPolling(host as unknown as Parameters<typeof stopDebugPolling>[0]);
  stopKalshiDashboardPolling(host as unknown as Parameters<typeof stopKalshiDashboardPolling>[0]);
  stopDashboardPolling(host as unknown as Parameters<typeof stopDashboardPolling>[0]);
  cancelHostAnimationFrame(host.chatScrollFrame);
  host.chatScrollFrame = null;
  cancelHostAnimationFrame(host.logsScrollFrame);
  host.logsScrollFrame = null;
  clearHostTimeout(host.chatScrollTimeout);
  host.chatScrollTimeout = null;
  host.realtimeTalkSession?.stop();
  host.realtimeTalkSession = null;
  host.realtimeTalkActive = false;
  host.realtimeTalkStatus = "idle";
  host.realtimeTalkDetail = null;
  host.realtimeTalkTranscript = null;
  host.client?.stop();
  host.client = null;
  host.connected = false;
  host.connectionAttemptStarted = false;
  detachThemeListener(host as unknown as Parameters<typeof detachThemeListener>[0]);
  host.topbarObserver?.disconnect();
  host.topbarObserver = null;
  host.mobileViewportCleanup?.();
  host.mobileViewportCleanup = null;
  host.mobileResumeCleanup?.();
  host.mobileResumeCleanup = null;
  host.controlUiResponsivenessObserver?.disconnect();
  host.controlUiResponsivenessObserver = null;
}

export function handleUpdated(host: LifecycleHost, changed: Map<PropertyKey, unknown>) {
  if (host.tab === "chat" && host.chatManualRefreshInFlight) {
    return;
  }
  if (
    host.tab === "chat" &&
    (changed.has("chatMessages") ||
      changed.has("chatToolMessages") ||
      changed.has("chatStream") ||
      changed.has("chatLoading") ||
      changed.has("tab"))
  ) {
    const forcedByTab = changed.has("tab");
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
      forcedByTab || forcedByLoad || streamJustStarted || !host.chatHasAutoScrolled,
    );
  }
  if (
    host.tab === "logs" &&
    (changed.has("logsEntries") || changed.has("logsAutoFollow") || changed.has("tab"))
  ) {
    if (host.logsAutoFollow && host.logsAtBottom) {
      scheduleLogsScroll(
        host as unknown as Parameters<typeof scheduleLogsScroll>[0],
        changed.has("tab") || changed.has("logsAutoFollow"),
      );
    }
  }
}
