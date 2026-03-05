import type { OpenClawConfig } from "../config/config.js";
import { isTruthyEnvValue } from "../infra/env.js";
import { startWsEventsWatcher } from "./ws-events-watcher.js";

export type WsEventsWatcherLog = {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
};

export async function startWsEventsWatcherWithLogs(params: {
  cfg: OpenClawConfig;
  log: WsEventsWatcherLog;
  onSkipped?: () => void;
}) {
  if (isTruthyEnvValue(process.env.OPENCLAW_SKIP_WS_EVENTS_WATCHER)) {
    params.onSkipped?.();
    return;
  }

  try {
    const result = startWsEventsWatcher(params.cfg);
    if (result.started) {
      params.log.info("workspace events watcher started");
      return;
    }
    if (
      result.reason &&
      result.reason !== "hooks not enabled" &&
      result.reason !== "no workspace events target configured"
    ) {
      params.log.warn(`workspace events watcher not started: ${result.reason}`);
    }
  } catch (err) {
    params.log.error(`workspace events watcher failed to start: ${String(err)}`);
  }
}
