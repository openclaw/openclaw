import type { OpenClawConfig } from "../config/config.js";
import { isTruthyEnvValue } from "../infra/env.js";
import { startGmailWatcher } from "./gmail-watcher.js";

export type GMailWatcherLog = {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
};

export async function startGmailWatcherWithLogs(params: {
  cfg: OpenClawConfig;
  log: GMailWatcherLog;
  onSkipped?: () => void;
}) {
  if (isTruthyEnvValue(process.env.OPENCLAW_SKIP_GMAIL_WATCHER)) {
    params.onSkipped?.();
    return;
  }

  try {
    const gmailResult = await startGmailWatcher(params.cfg);
    
    if (gmailResult.started) {
      params.log.info("gmail watcher started");
      return;
    }

    if (gmailResult.status === "skipped") {
      // Codex bot fix: only show the note for intentional external setups
      const isExternalSetup = gmailResult.reason === "gmail topic required";
      
      const suffix = isExternalSetup
        ? ". Note: If using an external webhook (e.g. gog + Pub/Sub), this is expected. Ensure your configured Gmail hook endpoint is reachable."
        : "";

      params.log.warn(`gmail watcher not started: ${gmailResult.reason}${suffix}`);
    }
  } catch (err) {
    params.log.error(`gmail watcher failed to start: ${String(err)}`);
  }
}