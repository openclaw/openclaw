/**
 * Workspace Events Watcher Service
 *
 * Automatically starts the gws events +subscribe process when the gateway starts,
 * if hooks.workspaceEvents is configured with a target.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { hasBinary } from "../agents/skills.js";
import type { OpenClawConfig } from "../config/config.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { createWsEventsNdjsonLineHandler } from "./ws-events-bridge.js";
import {
  buildGwsEventsSubscribeArgs,
  resolveWsEventsHookRuntimeConfig,
  type WsEventsHookRuntimeConfig,
} from "./ws-events.js";

const log = createSubsystemLogger("ws-events-watcher");

let watcherProcess: ChildProcess | null = null;
let shuttingDown = false;
let currentConfig: WsEventsHookRuntimeConfig | null = null;

function isGwsAvailable(): boolean {
  return hasBinary("gws");
}

/**
 * Spawn the gws events +subscribe process (NDJSON on stdout).
 */
export function spawnGwsEventsSubscribe(cfg: WsEventsHookRuntimeConfig): ChildProcess {
  const args = buildGwsEventsSubscribeArgs(cfg);
  log.info(`starting gws ${args.join(" ")}`);

  const child = spawn("gws", args, {
    stdio: ["ignore", "pipe", "pipe"],
    detached: false,
  });

  const handleLine = createWsEventsNdjsonLineHandler(
    {
      hookUrl: cfg.hookUrl,
      hookToken: cfg.hookToken,
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

  child.on("exit", (code, signal) => {
    // Flush remaining buffer
    if (buffer.trim()) {
      handleLine(buffer);
      buffer = "";
    }
    if (shuttingDown) {
      return;
    }
    log.warn(`gws exited (code=${code}, signal=${signal}); restarting in 5s`);
    watcherProcess = null;
    setTimeout(() => {
      if (shuttingDown || !currentConfig) {
        return;
      }
      watcherProcess = spawnGwsEventsSubscribe(currentConfig);
    }, 5000);
  });

  return child;
}

export type WsEventsWatcherStartResult = {
  started: boolean;
  reason?: string;
};

/**
 * Start the workspace events watcher service.
 * Called automatically by the gateway if hooks.workspaceEvents is configured.
 */
export function startWsEventsWatcher(cfg: OpenClawConfig): WsEventsWatcherStartResult {
  if (!cfg.hooks?.enabled) {
    return { started: false, reason: "hooks not enabled" };
  }

  if (!cfg.hooks?.workspaceEvents?.target) {
    return { started: false, reason: "no workspace events target configured" };
  }

  if (!isGwsAvailable()) {
    return { started: false, reason: "gws binary not found" };
  }

  const resolved = resolveWsEventsHookRuntimeConfig(cfg, {});
  if (!resolved.ok) {
    return { started: false, reason: resolved.error };
  }

  const runtimeConfig = resolved.value;
  currentConfig = runtimeConfig;

  shuttingDown = false;
  watcherProcess = spawnGwsEventsSubscribe(runtimeConfig);
  log.info(`workspace events watcher started for ${runtimeConfig.target}`);
  return { started: true };
}

/**
 * Stop the workspace events watcher service.
 */
export async function stopWsEventsWatcher(): Promise<void> {
  shuttingDown = true;

  if (watcherProcess) {
    log.info("stopping workspace events watcher");
    watcherProcess.kill("SIGTERM");

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
  log.info("workspace events watcher stopped");
}

/**
 * Check if the workspace events watcher is running.
 */
export function isWsEventsWatcherRunning(): boolean {
  return watcherProcess !== null && !shuttingDown;
}
