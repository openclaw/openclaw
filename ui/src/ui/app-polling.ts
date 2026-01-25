import { loadLogs } from "./controllers/logs";
import { loadNodes } from "./controllers/nodes";
import { loadDebug } from "./controllers/debug";
import { refreshOverseer } from "./controllers/overseer";
import type { ClawdbotApp } from "./app";

type PollingHost = {
  nodesPollInterval: number | null;
  logsPollInterval: number | null;
  debugPollInterval: number | null;
  overseerPollInterval: number | null;
  tab: string;
};

export function startNodesPolling(host: PollingHost) {
  if (host.nodesPollInterval != null) return;
  host.nodesPollInterval = window.setInterval(
    () => void loadNodes(host as unknown as ClawdbotApp, { quiet: true }),
    5000,
  );
}

export function stopNodesPolling(host: PollingHost) {
  if (host.nodesPollInterval == null) return;
  clearInterval(host.nodesPollInterval);
  host.nodesPollInterval = null;
}

export function startLogsPolling(host: PollingHost) {
  if (host.logsPollInterval != null) return;
  host.logsPollInterval = window.setInterval(() => {
    if (host.tab !== "logs") return;
    void loadLogs(host as unknown as ClawdbotApp, { quiet: true });
  }, 2000);
}

export function stopLogsPolling(host: PollingHost) {
  if (host.logsPollInterval == null) return;
  clearInterval(host.logsPollInterval);
  host.logsPollInterval = null;
}

export function startDebugPolling(host: PollingHost) {
  if (host.debugPollInterval != null) return;
  host.debugPollInterval = window.setInterval(() => {
    if (host.tab !== "debug") return;
    void loadDebug(host as unknown as ClawdbotApp);
  }, 3000);
}

export function stopDebugPolling(host: PollingHost) {
  if (host.debugPollInterval == null) return;
  clearInterval(host.debugPollInterval);
  host.debugPollInterval = null;
}

export function startOverseerPolling(host: PollingHost) {
  if (host.overseerPollInterval != null) return;
  host.overseerPollInterval = window.setInterval(() => {
    if (host.tab !== "overseer") return;
    void refreshOverseer(host as unknown as ClawdbotApp, { quiet: true });
  }, 5000);
}

export function stopOverseerPolling(host: PollingHost) {
  if (host.overseerPollInterval == null) return;
  clearInterval(host.overseerPollInterval);
  host.overseerPollInterval = null;
}
