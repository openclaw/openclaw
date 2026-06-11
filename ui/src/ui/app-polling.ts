import type { OpenClawApp } from "./app.ts";
import type { DebugState } from "./controllers/debug.ts";
import { loadDebug } from "./controllers/debug.ts";
import { loadKalshiDashboard } from "./controllers/kalshi-dashboard.ts";
import type { LogsState } from "./controllers/logs.ts";
import { loadLogs } from "./controllers/logs.ts";
import type { NodesState } from "./controllers/nodes.ts";
import { loadNodes } from "./controllers/nodes.ts";

type PollingHost = {
  nodesPollInterval: number | null;
  logsPollInterval: number | null;
  debugPollInterval: number | null;
  kalshiDashboardPollInterval: number | null;
  dashboardPollInterval?: number | null;
  dashboardPollInFlight?: boolean;
  tab: string;
  agentsPanel?: string;
  connected?: boolean;
  kalshiDashboardAuditPages?: Record<string, number>;
  kalshiDashboardAuditQueries?: Record<string, string>;
  kalshiDashboardShowDeepAudit?: boolean;
  refreshActiveDashboardTab?: () => Promise<void> | void;
};

const DASHBOARD_POLL_INTERVAL_MS = 15_000;
const KALSHI_DASHBOARD_POLL_INTERVAL_MS = 15_000;
const DASHBOARD_POLL_TABS = new Set([
  "overview",
  "channels",
  "instances",
  "usage",
  "sessions",
  "projects",
  "appStudio",
  "bookWriter",
  "patternLab",
  "cron",
  "skills",
  "agents",
  "agentWorkflows",
  "nodes",
  "dreams",
]);

export function startNodesPolling(host: PollingHost) {
  if (host.nodesPollInterval != null) {
    return;
  }
  host.nodesPollInterval = window.setInterval(() => {
    if (host.tab !== "nodes") {
      return;
    }
    void loadNodes(host as unknown as NodesState, { quiet: true });
  }, 5000);
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
    void loadLogs(host as unknown as LogsState, { quiet: true });
  }, 2000);
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

export function startKalshiDashboardPolling(host: PollingHost) {
  if (typeof window === "undefined") {
    return;
  }
  void loadKalshiDashboard(host as unknown as OpenClawApp, kalshiDashboardPollingOptions(host));
  if (host.kalshiDashboardPollInterval != null) {
    return;
  }
  host.kalshiDashboardPollInterval = window.setInterval(() => {
    if (!shouldPollKalshiDashboard(host)) {
      return;
    }
    void loadKalshiDashboard(host as unknown as OpenClawApp, kalshiDashboardPollingOptions(host));
  }, KALSHI_DASHBOARD_POLL_INTERVAL_MS);
}

function kalshiDashboardPollingOptions(host: PollingHost) {
  const view = kalshiDashboardPollingView(host);
  if (view !== "full") {
    return { quiet: true, view };
  }
  const options: {
    auditTablePages?: Record<string, number>;
    auditTableQueries?: Record<string, string>;
    quiet: true;
    view: "full";
  } = { quiet: true, view };
  if (host.kalshiDashboardAuditPages) {
    options.auditTablePages = host.kalshiDashboardAuditPages;
  }
  if (host.kalshiDashboardAuditQueries) {
    options.auditTableQueries = host.kalshiDashboardAuditQueries;
  }
  return options;
}

function kalshiDashboardPollingView(host: {
  tab: string;
  kalshiDashboardShowDeepAudit?: boolean;
}): "full" | "workspace" {
  return host.tab === "kalshi" && host.kalshiDashboardShowDeepAudit ? "full" : "workspace";
}

export function shouldPollKalshiDashboard(host: { tab: string; agentsPanel?: string }): boolean {
  return (
    host.tab === "kalshi" ||
    host.tab === "agentWorkflows" ||
    (host.tab === "agents" && (host.agentsPanel === "room" || host.agentsPanel === "workflows"))
  );
}

export function stopKalshiDashboardPolling(host: PollingHost) {
  if (host.kalshiDashboardPollInterval == null) {
    return;
  }
  clearInterval(host.kalshiDashboardPollInterval);
  host.kalshiDashboardPollInterval = null;
}

export function startDashboardPolling(host: PollingHost) {
  if (host.dashboardPollInterval != null || typeof window === "undefined") {
    return;
  }
  host.dashboardPollInterval = window.setInterval(() => {
    if (!host.connected || !DASHBOARD_POLL_TABS.has(host.tab)) {
      return;
    }
    if (typeof document !== "undefined" && document.visibilityState === "hidden") {
      return;
    }
    if (host.dashboardPollInFlight) {
      return;
    }
    host.dashboardPollInFlight = true;
    void Promise.resolve(host.refreshActiveDashboardTab?.()).finally(() => {
      host.dashboardPollInFlight = false;
    });
  }, DASHBOARD_POLL_INTERVAL_MS);
}

export function stopDashboardPolling(host: PollingHost) {
  if (host.dashboardPollInterval == null) {
    return;
  }
  clearInterval(host.dashboardPollInterval);
  host.dashboardPollInterval = null;
  host.dashboardPollInFlight = false;
}
