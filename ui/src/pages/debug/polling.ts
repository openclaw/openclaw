import { loadDebug, type DebugState } from "./data.ts";

type DebugPollingHost = DebugState & {
  debugPollInterval: number | null;
};

export function startDebugPolling(host: DebugPollingHost) {
  if (host.debugPollInterval != null) {
    return;
  }
  host.debugPollInterval = window.setInterval(() => {
    void loadDebug(host);
  }, 3000);
}

export function stopDebugPolling(host: Pick<DebugPollingHost, "debugPollInterval">) {
  if (host.debugPollInterval == null) {
    return;
  }
  clearInterval(host.debugPollInterval);
  host.debugPollInterval = null;
}
