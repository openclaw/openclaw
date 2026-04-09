import type { OpenClawApp } from "./app.ts";
import { loadDebug } from "./controllers/debug.ts";
import { loadLogs } from "./controllers/logs.ts";
import { loadNodes } from "./controllers/nodes.ts";

/**
 * Polling intervals (ms).
 *
 * Previous values (5 s / 2 s / 3 s) caused excessive RPC traffic and
 * progressive UI sluggishness — especially with many sessions or when
 * the dashboard was left open in a background tab.
 *
 * New defaults balance freshness with resource usage:
 *   - Nodes:  30 s  (topology rarely changes)
 *   - Logs:    5 s  (still near-realtime tail)
 *   - Debug:  10 s  (status data is slow-moving)
 */
const NODES_POLL_MS = 30_000;
const LOGS_POLL_MS = 5_000;
const DEBUG_POLL_MS = 10_000;

type PollingHost = {
  nodesPollInterval: number | null;
  logsPollInterval: number | null;
  debugPollInterval: number | null;
  tab: string;
};

export function startNodesPolling(host: PollingHost) {
  if (host.nodesPollInterval != null) {
    return;
  }
  host.nodesPollInterval = window.setInterval(
    () => void loadNodes(host as unknown as OpenClawApp, { quiet: true }),
    NODES_POLL_MS,
  );
}

export function stopNodesPolling(host: PollingHost) {
  if (host.nodesPollInterval == null) {
    return;
  }
  clearInterval(host.nodesPollInterval);
  host.nodesPollInterval = null;
}

export function startLogsPolling(host: PollingHost) {
  if (host.logsPollInterval != null) {
    return;
  }
  host.logsPollInterval = window.setInterval(() => {
    if (host.tab !== "logs") {
      return;
    }
    void loadLogs(host as unknown as OpenClawApp, { quiet: true });
  }, LOGS_POLL_MS);
}

export function stopLogsPolling(host: PollingHost) {
  if (host.logsPollInterval == null) {
    return;
  }
  clearInterval(host.logsPollInterval);
  host.logsPollInterval = null;
}

export function startDebugPolling(host: PollingHost) {
  if (host.debugPollInterval != null) {
    return;
  }
  host.debugPollInterval = window.setInterval(() => {
    if (host.tab !== "debug") {
      return;
    }
    void loadDebug(host as unknown as OpenClawApp);
  }, DEBUG_POLL_MS);
}

export function stopDebugPolling(host: PollingHost) {
  if (host.debugPollInterval == null) {
    return;
  }
  clearInterval(host.debugPollInterval);
  host.debugPollInterval = null;
}
