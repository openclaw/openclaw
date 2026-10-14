// Gmail watcher lifecycle helpers manage watcher process state from config.
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isTruthyEnvValue } from "../infra/env.js";
import type { SubsystemLogger } from "../logging/subsystem.js";
import { startGmailWatcher } from "./gmail-watcher.js";

/** Start the Gmail watcher with startup logs and env-based skip handling. */
export async function startGmailWatcherWithLogs(
  params: Parameters<typeof startGmailWatcher>[1] & {
    cfg: OpenClawConfig;
    log: Pick<SubsystemLogger, "info" | "warn" | "error">;
    onSkipped?: () => void;
  },
) {
  if (isTruthyEnvValue(process.env.OPENCLAW_SKIP_GMAIL_WATCHER)) {
    // Test and local recovery paths use the env skip to avoid starting a long
    // lived watcher while still exercising gateway startup.
    params.onSkipped?.();
    return;
  }

  try {
    const gmailResult = await startGmailWatcher(params.cfg, {
      signal: params.signal,
      scheduler: params.scheduler,
    });
    if (gmailResult.started) {
      params.log.info("gmail watcher started");
      return;
    }
    if (
      gmailResult.reason &&
      gmailResult.reason !== "hooks not enabled" &&
      gmailResult.reason !== "no gmail account configured"
    ) {
      params.log.warn(`gmail watcher not started: ${gmailResult.reason}`);
    }
  } catch (err) {
    params.log.error(`gmail watcher failed to start: ${String(err)}`);
  }
}
