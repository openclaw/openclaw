import type { OpenClawConfig } from "../config/config.js";
import { isTruthyEnvValue } from "../infra/env.js";
import { startImapWatcher } from "./imap-watcher.js";

export type ImapWatcherLog = {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
};

export async function startImapWatcherWithLogs(params: {
  cfg: OpenClawConfig;
  log: ImapWatcherLog;
  onSkipped?: () => void;
}) {
  if (isTruthyEnvValue(process.env.OPENCLAW_SKIP_IMAP_WATCHER)) {
    params.onSkipped?.();
    return;
  }

  try {
    const result = await startImapWatcher(params.cfg);
    if (result.started) {
      params.log.info("imap watcher started");
      return;
    }
    if (
      result.reason &&
      result.reason !== "hooks not enabled" &&
      result.reason !== "no imap account configured" &&
      result.reason !== "imap account required"
    ) {
      params.log.warn(`imap watcher not started: ${result.reason}`);
    }
  } catch (err) {
    params.log.error(`imap watcher failed to start: ${String(err)}`);
  }
}
