import type { OpenClawApp } from "./app.ts";
import { loadChannels } from "./controllers/channels.ts";
import { loadCronJobs, loadCronStatus } from "./controllers/cron.ts";
import { captureDashboardTimeline } from "./controllers/dashboard-timeline.ts";
import { loadDashboardSummary } from "./controllers/dashboard.ts";
import { loadDebug } from "./controllers/debug.ts";
import { loadDevices } from "./controllers/devices.ts";
import { loadLogs } from "./controllers/logs.ts";
import { loadNodes } from "./controllers/nodes.ts";
import { loadPresence } from "./controllers/presence.ts";
import { loadSessions } from "./controllers/sessions.ts";
import { loadUsage } from "./controllers/usage.ts";

type PollingHost = {
  nodesPollInterval: number | null;
  overviewFastPollInterval: number | null;
  overviewSlowPollInterval: number | null;
  dashboardTimelinePollInterval: number | null;
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
    5000,
  );
}

export function stopNodesPolling(host: PollingHost) {
  if (host.nodesPollInterval == null) {
    return;
  }
  clearInterval(host.nodesPollInterval);
  host.nodesPollInterval = null;
}

export function startOverviewPolling(host: PollingHost) {
  if (
    host.overviewFastPollInterval != null ||
    host.overviewSlowPollInterval != null ||
    host.dashboardTimelinePollInterval != null
  ) {
    return;
  }
  host.overviewFastPollInterval = window.setInterval(() => {
    if (host.tab !== "overview") {
      return;
    }
    void Promise.all([
      loadChannels(host as unknown as OpenClawApp, false),
      loadPresence(host as unknown as OpenClawApp),
      loadSessions(host as unknown as OpenClawApp),
      loadCronStatus(host as unknown as OpenClawApp),
      loadDashboardSummary(host as unknown as OpenClawApp, { quiet: true }),
      loadDebug(host as unknown as OpenClawApp, { probe: false, includeModels: false }),
      loadLogs(host as unknown as OpenClawApp, { quiet: true }),
    ]);
  }, 5000);
  host.dashboardTimelinePollInterval = window.setInterval(() => {
    if (host.tab !== "overview") {
      return;
    }
    captureDashboardTimeline(host as unknown as OpenClawApp);
  }, 15000);
  host.overviewSlowPollInterval = window.setInterval(() => {
    if (host.tab !== "overview") {
      return;
    }
    void Promise.all([
      loadCronJobs(host as unknown as OpenClawApp),
      loadUsage(host as unknown as OpenClawApp),
      loadDevices(host as unknown as OpenClawApp, { quiet: true }),
    ]);
  }, 60000);
}

export function stopOverviewPolling(host: PollingHost) {
  if (host.overviewFastPollInterval != null) {
    clearInterval(host.overviewFastPollInterval);
    host.overviewFastPollInterval = null;
  }
  if (host.overviewSlowPollInterval != null) {
    clearInterval(host.overviewSlowPollInterval);
    host.overviewSlowPollInterval = null;
  }
  if (host.dashboardTimelinePollInterval != null) {
    clearInterval(host.dashboardTimelinePollInterval);
    host.dashboardTimelinePollInterval = null;
  }
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
    void loadDebug(host as unknown as OpenClawApp);
  }, 3000);
}

export function stopDebugPolling(host: PollingHost) {
  if (host.debugPollInterval == null) {
    return;
  }
  clearInterval(host.debugPollInterval);
  host.debugPollInterval = null;
}
