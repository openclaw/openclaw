/**
 * Gmail Watcher Service
 *
 * Automatically starts the Gmail watcher when the gateway starts,
 * if hooks.gmail is configured with an account.
 *
 * Supports two backends:
 * - gog (default): push-based via `gog gmail watch serve`
 * - gws: pull-based via `gws gmail +watch` (NDJSON on stdout)
 */

import { type ChildProcess, spawn } from "node:child_process";
import { hasBinary } from "../agents/skills.js";
import type { OpenClawConfig } from "../config/config.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { runCommandWithTimeout } from "../process/exec.js";
import { createNdjsonLineHandler } from "./gmail-gws-bridge.js";
import { ensureTailscaleEndpoint } from "./gmail-setup-utils.js";
import {
  buildGogWatchServeArgs,
  buildGogWatchStartArgs,
  buildGwsWatchArgs,
  type GmailHookRuntimeConfig,
  resolveGmailHookRuntimeConfig,
} from "./gmail.js";

const log = createSubsystemLogger("gmail-watcher");

const ADDRESS_IN_USE_RE = /address already in use|EADDRINUSE/i;

export function isAddressInUseError(line: string): boolean {
  return ADDRESS_IN_USE_RE.test(line);
}

let watcherProcess: ChildProcess | null = null;
let renewInterval: ReturnType<typeof setInterval> | null = null;
let shuttingDown = false;
let currentConfig: GmailHookRuntimeConfig | null = null;
// Generation counter to prevent stale restart timers from spawning duplicate watchers
// after a stop+start cycle (hot-reload). Each start/stop bumps the counter, and
// pending restart timers check their captured generation before respawning.
let watcherGeneration = 0;

function isGogAvailable(): boolean {
  return hasBinary("gog");
}

function isGwsAvailable(): boolean {
  return hasBinary("gws");
}

/**
 * Start the Gmail watch via gog (registers with Gmail API).
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
 * Spawn the gog gmail watch serve process.
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
    const gen = watcherGeneration;
    setTimeout(() => {
      if (shuttingDown || !currentConfig || watcherGeneration !== gen) {
        return;
      }
      watcherProcess = spawnGogServe(currentConfig);
    }, 5000);
  });

  return child;
}

/**
 * Spawn the gws gmail +watch process (pull-based, NDJSON on stdout).
 */
export function spawnGwsWatch(cfg: GmailHookRuntimeConfig): ChildProcess {
  const args = buildGwsWatchArgs(cfg);
  log.info(`starting gws ${args.join(" ")}`);

  const child = spawn("gws", args, {
    stdio: ["ignore", "pipe", "pipe"],
    detached: false,
  });

  const handleLine = createNdjsonLineHandler(
    {
      hookUrl: cfg.hookUrl,
      hookToken: cfg.hookToken,
      includeBody: cfg.includeBody,
      maxBytes: cfg.maxBytes,
    },
    log,
  );

  // Buffer partial lines from stdout (NDJSON may arrive in chunks)
  let buffer = "";
  child.stdout?.on("data", (data: Buffer) => {
    buffer += data.toString();
    const lines = buffer.split("\n");
    // Keep last (possibly incomplete) segment in the buffer
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      handleLine(line);
    }
  });

  child.stderr?.on("data", (data: Buffer) => {
    const line = data.toString().trim();
    if (line) {
      log.warn(`[gws] ${line}`);
    }
  });

  child.on("error", (err) => {
    log.error(`gws process error: ${String(err)}`);
  });

  // Flush remaining buffer on exit (restart logic is handled by callers)
  child.on("exit", () => {
    if (buffer.trim()) {
      handleLine(buffer);
      buffer = "";
    }
  });

  return child;
}

/**
 * Start the gog-based watcher (push model).
 */
async function startGogWatcher(
  runtimeConfig: GmailHookRuntimeConfig,
): Promise<GmailWatcherStartResult> {
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

  log.info(
    `gmail watcher started for ${runtimeConfig.account} (renew every ${runtimeConfig.renewEveryMinutes}m)`,
  );
  return { started: true };
}

/**
 * Start the gws-based watcher (pull model, no Tailscale, no renewal).
 */
function startGwsWatcher(runtimeConfig: GmailHookRuntimeConfig): GmailWatcherStartResult {
  shuttingDown = false;

  function spawnAndWatch() {
    const proc = spawnGwsWatch(runtimeConfig);
    watcherProcess = proc;
    proc.on("exit", (code, signal) => {
      if (shuttingDown) {
        return;
      }
      log.warn(`gws exited (code=${code}, signal=${signal}); restarting in 5s`);
      watcherProcess = null;
      const gen = watcherGeneration;
      setTimeout(() => {
        if (shuttingDown || !currentConfig || watcherGeneration !== gen) {
          return;
        }
        spawnAndWatch();
      }, 5000);
    });
  }

  spawnAndWatch();
  log.info(`gmail watcher (gws) started for ${runtimeConfig.account}`);
  return { started: true };
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
  if (!cfg.hooks?.enabled) {
    return { started: false, reason: "hooks not enabled" };
  }

  if (!cfg.hooks?.gmail?.account) {
    return { started: false, reason: "no gmail account configured" };
  }

  const cliMode = cfg.hooks.gmail.cli ?? "gog";

  if (cliMode === "gws") {
    if (!isGwsAvailable()) {
      return { started: false, reason: "gws binary not found" };
    }
  } else {
    if (!isGogAvailable()) {
      return { started: false, reason: "gog binary not found" };
    }
  }

  // Resolve the full runtime config
  const resolved = resolveGmailHookRuntimeConfig(cfg, {});
  if (!resolved.ok) {
    return { started: false, reason: resolved.error };
  }

  const runtimeConfig = resolved.value;
  currentConfig = runtimeConfig;

  // Invalidate any pending restart timers from a previous watcher lifecycle
  watcherGeneration += 1;

  if (cliMode === "gws") {
    return startGwsWatcher(runtimeConfig);
  }
  return startGogWatcher(runtimeConfig);
}

/**
 * Stop the Gmail watcher service.
 */
export async function stopGmailWatcher(): Promise<void> {
  watcherGeneration += 1;
  shuttingDown = true;

  if (renewInterval) {
    clearInterval(renewInterval);
    renewInterval = null;
  }

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
