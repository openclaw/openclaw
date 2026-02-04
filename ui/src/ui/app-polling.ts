<<<<<<< HEAD
import type { OpenClawApp } from "./app";
import { loadDebug } from "./controllers/debug";
import { loadLogs } from "./controllers/logs";
import { loadNodes } from "./controllers/nodes";
=======
import type { OpenClawApp } from "./app.ts";
import { loadDebug } from "./controllers/debug.ts";
import { loadLogs } from "./controllers/logs.ts";
import { loadNodes } from "./controllers/nodes.ts";
>>>>>>> upstream/main

type PollingHost = {
  nodesPollInterval: number | null;
  logsPollInterval: number | null;
  debugPollInterval: number | null;
  tab: string;
};

export function startNodesPolling(host: PollingHost) {
<<<<<<< HEAD
  if (host.nodesPollInterval != null) return;
=======
  if (host.nodesPollInterval != null) {
    return;
  }
>>>>>>> upstream/main
  host.nodesPollInterval = window.setInterval(
    () => void loadNodes(host as unknown as OpenClawApp, { quiet: true }),
    5000,
  );
}

export function stopNodesPolling(host: PollingHost) {
<<<<<<< HEAD
  if (host.nodesPollInterval == null) return;
=======
  if (host.nodesPollInterval == null) {
    return;
  }
>>>>>>> upstream/main
  clearInterval(host.nodesPollInterval);
  host.nodesPollInterval = null;
}

export function startLogsPolling(host: PollingHost) {
<<<<<<< HEAD
  if (host.logsPollInterval != null) return;
  host.logsPollInterval = window.setInterval(() => {
    if (host.tab !== "logs") return;
=======
  if (host.logsPollInterval != null) {
    return;
  }
  host.logsPollInterval = window.setInterval(() => {
    if (host.tab !== "logs") {
      return;
    }
>>>>>>> upstream/main
    void loadLogs(host as unknown as OpenClawApp, { quiet: true });
  }, 2000);
}

export function stopLogsPolling(host: PollingHost) {
<<<<<<< HEAD
  if (host.logsPollInterval == null) return;
=======
  if (host.logsPollInterval == null) {
    return;
  }
>>>>>>> upstream/main
  clearInterval(host.logsPollInterval);
  host.logsPollInterval = null;
}

export function startDebugPolling(host: PollingHost) {
<<<<<<< HEAD
  if (host.debugPollInterval != null) return;
  host.debugPollInterval = window.setInterval(() => {
    if (host.tab !== "debug") return;
=======
  if (host.debugPollInterval != null) {
    return;
  }
  host.debugPollInterval = window.setInterval(() => {
    if (host.tab !== "debug") {
      return;
    }
>>>>>>> upstream/main
    void loadDebug(host as unknown as OpenClawApp);
  }, 3000);
}

export function stopDebugPolling(host: PollingHost) {
<<<<<<< HEAD
  if (host.debugPollInterval == null) return;
=======
  if (host.debugPollInterval == null) {
    return;
  }
>>>>>>> upstream/main
  clearInterval(host.debugPollInterval);
  host.debugPollInterval = null;
}
