/**
 * Gmail Watcher Service
 *
 * Automatically starts `gog gmail watch serve` when the gateway starts,
 * if hooks.gmail is configured with an account.
 *
 * Supports two delivery modes (both can run simultaneously):
 *  - Push: Google Pub/Sub sends real-time notifications to gog watch serve
 *  - Poll: Periodic fallback that checks Gmail history for missed messages
 */

import { type ChildProcess, spawn } from "node:child_process";
import { request as httpRequest } from "node:http";
import { hasBinary } from "../agents/skills.js";
import type { OpenClawConfig } from "../config/config.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { runCommandWithTimeout } from "../process/exec.js";
import { runGmailAutoSetup } from "./gmail-auto-setup.js";
import { ensureTailscaleEndpoint } from "./gmail-setup-utils.js";
import {
  buildGogWatchServeArgs,
  buildGogWatchStartArgs,
  type GmailHookRuntimeConfig,
  resolveGmailHookRuntimeConfig,
} from "./gmail.js";

const log = createSubsystemLogger("gmail-watcher");

const ADDRESS_IN_USE_RE = /address already in use|EADDRINUSE/i;
const DEFAULT_POLL_INTERVAL_SECONDS = 60;

export function isAddressInUseError(line: string): boolean {
  return ADDRESS_IN_USE_RE.test(line);
}

let watcherProcess: ChildProcess | null = null;
let renewInterval: ReturnType<typeof setInterval> | null = null;
let pollTimeout: ReturnType<typeof setTimeout> | null = null;
let lastPollHistoryId: string | null = null;
let shuttingDown = false;
let currentConfig: GmailHookRuntimeConfig | null = null;

/**
 * Check if gog binary is available
 */
function isGogAvailable(): boolean {
  return hasBinary("gog");
}

/**
 * Start the Gmail watch (registers with Gmail API)
 */
async function startGmailWatch(
  cfg: Pick<GmailHookRuntimeConfig, "account" | "label" | "topic">,
): Promise<boolean> {
  const args = ["gog", ...buildGogWatchStartArgs(cfg)];
  try {
    const result = await runCommandWithTimeout(args, { timeoutMs: 120_000 });
    if (result.code !== 0) {
      const message = result.stderr || result.stdout || "gog watch start failed";
      log.error(`watch start failed: ${message}`);
      return false;
    }
    log.info(`watch started for ${cfg.account}`);
    return true;
  } catch (err) {
    log.error(`watch start error: ${String(err)}`);
    return false;
  }
}

/**
 * Spawn the gog gmail watch serve process
 */
function spawnGogServe(cfg: GmailHookRuntimeConfig): ChildProcess {
  const args = buildGogWatchServeArgs(cfg);
  log.info(`starting gog ${args.join(" ")}`);
  let addressInUse = false;

  const child = spawn("gog", args, {
    stdio: ["ignore", "pipe", "pipe"],
    detached: false,
  });

  child.stdout?.on("data", (data: Buffer) => {
    const line = data.toString().trim();
    if (line) {
      log.info(`[gog] ${line}`);
    }
  });

  child.stderr?.on("data", (data: Buffer) => {
    const line = data.toString().trim();
    if (!line) {
      return;
    }
    if (isAddressInUseError(line)) {
      addressInUse = true;
    }
    log.warn(`[gog] ${line}`);
  });

  child.on("error", (err) => {
    log.error(`gog process error: ${String(err)}`);
  });

  child.on("exit", (code, signal) => {
    if (shuttingDown) {
      return;
    }
    if (addressInUse) {
      log.warn(
        "gog serve failed to bind (address already in use); stopping restarts. " +
          "Another watcher is likely running. Set OPENCLAW_SKIP_GMAIL_WATCHER=1 or stop the other process.",
      );
      watcherProcess = null;
      return;
    }
    log.warn(`gog exited (code=${code}, signal=${signal}); restarting in 5s`);
    watcherProcess = null;
    setTimeout(() => {
      if (shuttingDown || !currentConfig) {
        return;
      }
      watcherProcess = spawnGogServe(currentConfig);
    }, 5000);
  });

  return child;
}

/**
 * Poll Gmail history for new messages and poke gog watch serve if any are found.
 * This is a fallback for when Pub/Sub push notifications are delayed or missed.
 */
async function pollGmailHistory(cfg: GmailHookRuntimeConfig): Promise<void> {
  if (shuttingDown) {
    return;
  }

  // Get the current historyId from gog watch status
  if (!lastPollHistoryId) {
    try {
      const statusResult = await runCommandWithTimeout(
        ["gog", "gmail", "watch", "status", "--account", cfg.account, "--json"],
        { timeoutMs: 15_000 },
      );
      if (statusResult.code === 0 && statusResult.stdout) {
        const status = JSON.parse(statusResult.stdout) as { history_id?: string };
        if (status.history_id) {
          lastPollHistoryId = status.history_id;
          log.debug(`poll: initialized historyId=${lastPollHistoryId}`);
        }
      }
    } catch {
      log.debug("poll: could not read watch status, will retry next cycle");
      return;
    }
  }

  if (!lastPollHistoryId) {
    return;
  }

  try {
    const historyResult = await runCommandWithTimeout(
      [
        "gog",
        "gmail",
        "history",
        "--account",
        cfg.account,
        "--since",
        lastPollHistoryId,
        "--json",
        "--max",
        "10",
      ],
      { timeoutMs: 15_000 },
    );

    if (historyResult.code !== 0) {
      log.debug(`poll: history check failed (code=${historyResult.code})`);
      return;
    }

    const history = JSON.parse(historyResult.stdout) as {
      historyId?: string;
      messages?: Array<{ id: string }> | null;
    };

    const newHistoryId = history.historyId;
    if (!newHistoryId || newHistoryId === lastPollHistoryId) {
      return; // No changes
    }

    // Update stored historyId regardless of whether there are messages
    const previousId = lastPollHistoryId;
    lastPollHistoryId = newHistoryId;

    if (!history.messages || history.messages.length === 0) {
      return; // historyId advanced but no new messages (e.g. label changes)
    }

    log.info(
      `poll: detected ${history.messages.length} new message(s) (history ${previousId}→${newHistoryId}), poking gog`,
    );

    // Send a synthetic Pub/Sub push to gog watch serve to trigger its fetch+forward pipeline.
    // gog deduplicates via historyId, so this is safe even if push already delivered.
    await pokeGogServe(cfg, newHistoryId);
  } catch (err) {
    log.debug(`poll: error checking history: ${String(err)}`);
  }
}

/**
 * Send a synthetic Pub/Sub-style push notification to the local gog watch serve process.
 * This triggers gog's existing fetch+format+forward pipeline.
 */
function pokeGogServe(cfg: GmailHookRuntimeConfig, historyId: string): Promise<void> {
  const data = Buffer.from(
    JSON.stringify({ emailAddress: cfg.account, historyId: historyId }),
  ).toString("base64");

  const payload = JSON.stringify({
    message: { data, messageId: `poll-${Date.now()}` },
    subscription: `projects/-/subscriptions/poll-fallback`,
  });

  const token = cfg.pushToken;
  const url = `http://${cfg.serve.bind}:${cfg.serve.port}${cfg.serve.path}?token=${encodeURIComponent(token)}`;

  return new Promise<void>((resolve) => {
    const req = httpRequest(
      url,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(payload),
        },
        timeout: 10_000,
      },
      (res) => {
        // Drain the response
        res.resume();
        res.on("end", () => resolve());
        res.on("error", () => resolve());
      },
    );
    req.on("error", (err) => {
      log.debug(`poll: poke to gog failed: ${String(err)}`);
      resolve();
    });
    req.end(payload);
  });
}

/**
 * Start the poll timer using setTimeout chaining (runs after each poll completes).
 */
function startPollTimer(cfg: GmailHookRuntimeConfig, intervalMs: number): void {
  const scheduleNext = () => {
    if (shuttingDown) {
      return;
    }
    pollTimeout = setTimeout(() => {
      void pollGmailHistory(cfg).finally(scheduleNext);
    }, intervalMs);
  };
  log.info(`poll fallback enabled (every ${Math.round(intervalMs / 1000)}s)`);
  scheduleNext();
}

export type GmailWatcherStartResult = {
  started: boolean;
  reason?: string;
};

/**
 * Start the Gmail watcher service.
 * Called automatically by the gateway if hooks.gmail is configured.
 */
export async function startGmailWatcher(cfg: OpenClawConfig): Promise<GmailWatcherStartResult> {
  // Check if gmail hooks are configured
  if (!cfg.hooks?.enabled) {
    return { started: false, reason: "hooks not enabled" };
  }

  if (!cfg.hooks?.gmail?.account) {
    return { started: false, reason: "no gmail account configured" };
  }

  // Run config-driven auto-setup if configured (service account, gog creds, tailscale auth)
  const autoSetupResult = await runGmailAutoSetup(cfg);
  if (!autoSetupResult.ok) {
    log.error(`gmail auto-setup failed: ${autoSetupResult.error}`);
    return { started: false, reason: `auto-setup failed: ${autoSetupResult.error}` };
  }
  if (!autoSetupResult.skipped) {
    log.info("gmail auto-setup completed successfully");
  }

  // Check if gog is available
  const gogAvailable = isGogAvailable();
  if (!gogAvailable) {
    return { started: false, reason: "gog binary not found" };
  }

  // Resolve the full runtime config
  const resolved = resolveGmailHookRuntimeConfig(cfg, {});
  if (!resolved.ok) {
    return { started: false, reason: resolved.error };
  }

  const runtimeConfig = resolved.value;
  currentConfig = runtimeConfig;

  // Set up Tailscale endpoint if needed
  if (runtimeConfig.tailscale.mode !== "off") {
    try {
      await ensureTailscaleEndpoint({
        mode: runtimeConfig.tailscale.mode,
        path: runtimeConfig.tailscale.path,
        port: runtimeConfig.serve.port,
        target: runtimeConfig.tailscale.target,
      });
      log.info(
        `tailscale ${runtimeConfig.tailscale.mode} configured for port ${runtimeConfig.serve.port}`,
      );
    } catch (err) {
      log.error(`tailscale setup failed: ${String(err)}`);
      return {
        started: false,
        reason: `tailscale setup failed: ${String(err)}`,
      };
    }
  }

  // Start the Gmail watch (register with Gmail API)
  const watchStarted = await startGmailWatch(runtimeConfig);
  if (!watchStarted) {
    log.warn("gmail watch start failed, but continuing with serve");
  }

  // Spawn the gog serve process
  shuttingDown = false;
  watcherProcess = spawnGogServe(runtimeConfig);

  // Set up renewal interval
  const renewMs = runtimeConfig.renewEveryMinutes * 60_000;
  renewInterval = setInterval(() => {
    if (shuttingDown) {
      return;
    }
    void startGmailWatch(runtimeConfig);
  }, renewMs);

  // Start poll fallback (configurable, default 60s, 0 to disable)
  const pollIntervalRaw = cfg.hooks?.gmail?.pollIntervalSeconds;
  const pollIntervalSeconds =
    typeof pollIntervalRaw === "number" && Number.isFinite(pollIntervalRaw) && pollIntervalRaw >= 0
      ? Math.floor(pollIntervalRaw)
      : DEFAULT_POLL_INTERVAL_SECONDS;
  if (pollIntervalSeconds > 0) {
    startPollTimer(runtimeConfig, pollIntervalSeconds * 1000);
  }

  log.info(
    `gmail watcher started for ${runtimeConfig.account} (renew every ${runtimeConfig.renewEveryMinutes}m)`,
  );

  return { started: true };
}

/**
 * Stop the Gmail watcher service.
 */
export async function stopGmailWatcher(): Promise<void> {
  shuttingDown = true;

  if (renewInterval) {
    clearInterval(renewInterval);
    renewInterval = null;
  }

  if (pollTimeout) {
    clearTimeout(pollTimeout);
    pollTimeout = null;
  }
  lastPollHistoryId = null;

  if (watcherProcess) {
    log.info("stopping gmail watcher");
    watcherProcess.kill("SIGTERM");

    // Wait a bit for graceful shutdown
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        if (watcherProcess) {
          watcherProcess.kill("SIGKILL");
        }
        resolve();
      }, 3000);

      watcherProcess?.on("exit", () => {
        clearTimeout(timeout);
        resolve();
      });
    });

    watcherProcess = null;
  }

  currentConfig = null;
  log.info("gmail watcher stopped");
}

/**
 * Check if the Gmail watcher is running.
 */
export function isGmailWatcherRunning(): boolean {
  return watcherProcess !== null && !shuttingDown;
}
