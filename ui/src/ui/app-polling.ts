// Control UI module implements app polling behavior.
import type { DebugState } from "./controllers/debug.ts";
import { loadDebug } from "./controllers/debug.ts";
import type { NodesState } from "./controllers/nodes.ts";
import { loadNodes } from "./controllers/nodes.ts";

type PollingHost = {
  nodesPollInterval: number | null;
  debugPollInterval: number | null;
};

export const NODES_ACTIVE_POLL_INTERVAL_MS = 30_000;

export function startNodesPolling(host: PollingHost) {
  if (host.nodesPollInterval != null) {
    return;
  }
  host.nodesPollInterval = window.setInterval(() => {
    void loadNodes(host as unknown as NodesState, { quiet: true });
  }, NODES_ACTIVE_POLL_INTERVAL_MS);
}

export function stopNodesPolling(host: PollingHost) {
  if (host.nodesPollInterval == null) {
    return;
  }
  clearInterval(host.nodesPollInterval);
  host.nodesPollInterval = null;
}

export function startDebugPolling(host: PollingHost) {
  if (host.debugPollInterval != null) {
    return;
  }
  host.debugPollInterval = window.setInterval(() => {
    void loadDebug(host as unknown as DebugState);
  }, 3000);
}

export function stopDebugPolling(host: PollingHost) {
  if (host.debugPollInterval == null) {
    return;
  }
  clearInterval(host.debugPollInterval);
  host.debugPollInterval = null;
}
