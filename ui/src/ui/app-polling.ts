import type { OpenClawApp } from "./app.ts";
import { loadChatHistory } from "./controllers/chat.ts";
import { loadDebug } from "./controllers/debug.ts";
import { loadLogs } from "./controllers/logs.ts";
import { loadNodes } from "./controllers/nodes.ts";

type PollingHost = {
  nodesPollInterval: number | null;
  chatPollInterval: number | null;
  logsPollInterval: number | null;
  debugPollInterval: number | null;
  connected: boolean;
  tab: string;
  chatLoading: boolean;
  chatSending: boolean;
  chatRunId: string | null;
  chatManualRefreshInFlight?: boolean;
};

export function startNodesPolling(host: PollingHost) {
  if (host.nodesPollInterval != null) {
    return;
  }
  host.nodesPollInterval = globalThis.setInterval(
    () => void loadNodes(host as unknown as OpenClawApp, { quiet: true }),
    5000,
  ) as unknown as number;
}

export function stopNodesPolling(host: PollingHost) {
  if (host.nodesPollInterval == null) {
    return;
  }
  globalThis.clearInterval(host.nodesPollInterval);
  host.nodesPollInterval = null;
}

export function startChatPolling(host: PollingHost) {
  if (host.chatPollInterval != null) {
    return;
  }
  host.chatPollInterval = globalThis.setInterval(() => {
    if (host.tab !== "chat" || !host.connected) {
      return;
    }
    if (host.chatLoading || host.chatSending || host.chatRunId || host.chatManualRefreshInFlight) {
      return;
    }
    void loadChatHistory(host as unknown as OpenClawApp);
  }, 3000) as unknown as number;
}

export function stopChatPolling(host: PollingHost) {
  if (host.chatPollInterval == null) {
    return;
  }
  globalThis.clearInterval(host.chatPollInterval);
  host.chatPollInterval = null;
}

export function startLogsPolling(host: PollingHost) {
  if (host.logsPollInterval != null) {
    return;
  }
  host.logsPollInterval = globalThis.setInterval(() => {
    if (host.tab !== "logs") {
      return;
    }
    void loadLogs(host as unknown as OpenClawApp, { quiet: true });
  }, 2000) as unknown as number;
}

export function stopLogsPolling(host: PollingHost) {
  if (host.logsPollInterval == null) {
    return;
  }
  globalThis.clearInterval(host.logsPollInterval);
  host.logsPollInterval = null;
}

export function startDebugPolling(host: PollingHost) {
  if (host.debugPollInterval != null) {
    return;
  }
  host.debugPollInterval = globalThis.setInterval(() => {
    if (host.tab !== "debug") {
      return;
    }
    void loadDebug(host as unknown as OpenClawApp);
  }, 3000) as unknown as number;
}

export function stopDebugPolling(host: PollingHost) {
  if (host.debugPollInterval == null) {
    return;
  }
  globalThis.clearInterval(host.debugPollInterval);
  host.debugPollInterval = null;
}
