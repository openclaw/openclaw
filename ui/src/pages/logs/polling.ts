import { loadLogs, type LogsState } from "./data.ts";

type LogsPollingHost = {
  logsPollInterval: number | null;
};

export function startLogsPolling(host: LogsPollingHost) {
  if (host.logsPollInterval != null) {
    return;
  }
  host.logsPollInterval = window.setInterval(() => {
    void loadLogs(host as unknown as LogsState, { quiet: true });
  }, 2000);
}

export function stopLogsPolling(host: LogsPollingHost) {
  if (host.logsPollInterval == null) {
    return;
  }
  clearInterval(host.logsPollInterval);
  host.logsPollInterval = null;
}
