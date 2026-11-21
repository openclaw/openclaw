import { type ChildProcess, spawn } from "node:child_process";
import process from "node:process";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { computeBackoff } from "../infra/backoff.js";
import type {
  GatewayScheduledJob,
  GatewayScheduler,
  GatewaySchedulerScope,
} from "../infra/gateway-scheduler.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { releaseChildProcessOutputAfterExit } from "../process/child-process.js";
import { formatCommandResult } from "../process/command-error.js";
import { runCommandWithTimeout } from "../process/exec.js";
import { killProcessTree } from "../process/kill-tree.js";
import { hasBinary } from "../skills/loading/config.js";
import { inspectGog, type GogInspection } from "./gmail-gog.js";
import { ensureTailscaleEndpoint } from "./gmail-setup-utils.js";
import {
  buildGogWatchServeLogArgs,
  buildGogWatchServeArgs,
  buildGogWatchStartArgs,
  type GmailHookRuntimeConfig,
  type GmailTokenTransport,
  GMAIL_INSECURE_TOKEN_ARGS_WARNING,
  GMAIL_WATCH_PUSH_TOKEN_ENV,
  GMAIL_WATCH_HOOK_TOKEN_ENV,
  resolveGogServeInvocation,
  resolveGmailHookRuntimeConfig,
} from "./gmail.js";

const log = createSubsystemLogger("gmail-watcher");
const GMAIL_WATCHER_STDERR_TAIL_CHARS = 512;
const GMAIL_WATCH_RETRY_BACKOFF = { initialMs: 60_000, factor: 2, jitter: 0 };
const GMAIL_BIND_RETRY_LIMIT = 3;
const GMAIL_BIND_BACKOFF = { initialMs: 5_000, maxMs: 20_000, factor: 2, jitter: 0 };

let watcherProcess: ChildProcess | null = null;
let renewalScope: GatewaySchedulerScope | undefined;
let shuttingDown = false;
let currentConfig: GmailHookRuntimeConfig | null = null;
let respawnTimeout: ReturnType<typeof setTimeout> | null = null;

async function startGmailWatch(
  cfg: Pick<GmailHookRuntimeConfig, "account" | "label" | "topic">,
  executable: string,
  options: { signal?: AbortSignal } = {},
): Promise<boolean> {
  const invocation = resolveGogServeInvocation(buildGogWatchStartArgs(cfg), executable);
  try {
    const result = await runCommandWithTimeout([invocation.command, ...invocation.args], {
      timeoutMs: 120_000,
      signal: options.signal,
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
    });
    if (result.code !== 0) {
      log.error(formatCommandResult("gog gmail watch start", result));
      return false;
    }
    log.info(`watch started for ${cfg.account}`);
    return true;
  } catch (err) {
    log.error(`watch start error: ${String(err)}`);
    return false;
  }
}

function spawnGogServe(
  cfg: GmailHookRuntimeConfig,
  executable: string,
  transport: GmailTokenTransport,
  bindRetries = 0,
): ChildProcess {
  const args = buildGogWatchServeArgs(cfg, transport);
  log.info(`starting gog ${buildGogWatchServeLogArgs(cfg, transport).join(" ")}`);
  let addressInUse = false;
  let spawnFailed = false;
  // Carry a bounded tail so bind markers split across stderr chunks survive until close.
  let stderrTail = "";
  const invocation = resolveGogServeInvocation(args, executable);

  const child = spawn(invocation.command, invocation.args, {
    stdio: ["ignore", "pipe", "pipe"],
    // Own process group on Unix so killProcessTree can reach descendants on shutdown.
    detached: process.platform !== "win32",
    windowsHide: invocation.windowsHide,
    windowsVerbatimArguments: invocation.windowsVerbatimArguments,
    ...(transport === "env"
      ? {
          env: {
            ...process.env,
            [GMAIL_WATCH_PUSH_TOKEN_ENV]: cfg.pushToken,
            [GMAIL_WATCH_HOOK_TOKEN_ENV]: cfg.hookToken,
          },
        }
      : {}),
  });

  child.stdout?.on("error", (err) => {
    log.error(`gog stdout error: ${String(err)}`);
  });
  child.stdout?.on("data", (data: Buffer) => {
    const line = data.toString().trim();
    if (line) {
      log.info(`[gog] ${line}`);
    }
  });

  child.stderr?.on("error", (err) => {
    log.error(`gog stderr error: ${String(err)}`);
  });
  child.stderr?.on("data", (data: Buffer) => {
    const chunk = data.toString();
    // Classify before truncation so a marker completed across the retention boundary survives.
    const combined = stderrTail + chunk;
    if (!addressInUse && /address already in use|EADDRINUSE/i.test(combined)) {
      addressInUse = true;
    }
    stderrTail = combined.slice(-GMAIL_WATCHER_STDERR_TAIL_CHARS);
    const line = chunk.trim();
    if (!line) {
      return;
    }
    log.warn(`[gog] ${line}`);
  });

  child.on("error", (err) => {
    // Failed spawn emits close without a pid; later errors on a running child remain retryable.
    if (child.pid === undefined) {
      spawnFailed = true;
    }
    log.error(`gog process error: ${String(err)}`);
  });

  const releaseOutput = releaseChildProcessOutputAfterExit(child);
  child.once("exit", () => {
    // The detached POSIX group remains ours after its leader dies. Windows
    // taskkill requires a live root PID; only bound inherited-pipe drain there.
    if (!shuttingDown && watcherProcess === child && process.platform !== "win32" && child.pid) {
      killProcessTree(child.pid, { force: true, detached: true });
    }
  });

  // `close` follows bounded stdio drain, so late stderr still classifies bind failures.
  child.once("close", (code, signal) => {
    releaseOutput();
    if (shuttingDown || watcherProcess !== child) {
      return;
    }
    if (spawnFailed) {
      watcherProcess = null;
      return;
    }
    if (addressInUse && bindRetries >= GMAIL_BIND_RETRY_LIMIT) {
      log.error(
        `gog serve failed to bind after ${GMAIL_BIND_RETRY_LIMIT} retries (address already in use); stopping restarts. ` +
          "Stop the other process and restart the Gmail watcher, or set OPENCLAW_SKIP_GMAIL_WATCHER=1 if it is managed separately.",
      );
      watcherProcess = null;
      return;
    }
    const nextBindRetries = addressInUse ? bindRetries + 1 : 0;
    const delayMs = addressInUse ? computeBackoff(GMAIL_BIND_BACKOFF, nextBindRetries) : 5_000;
    log.warn(
      addressInUse
        ? `gog serve failed to bind (address already in use); retry ${nextBindRetries}/${GMAIL_BIND_RETRY_LIMIT} in ${delayMs / 1000}s`
        : `gog exited (code=${code}, signal=${signal}); restarting in 5s`,
    );
    watcherProcess = null;
    respawnTimeout = setTimeout(() => {
      respawnTimeout = null;
      if (shuttingDown || currentConfig !== cfg) {
        return;
      }
      // Keep the negotiated transport across retries; serve failures never authorize downgrade.
      watcherProcess = spawnGogServe(cfg, executable, transport, nextBindRetries);
    }, delayMs);
  });

  return child;
}

/**
 * Signal the gog process tree to exit gracefully (SIGTERM, SIGKILL after 3 s)
 * and resolve on exit/close/error or a final 8 s safety timeout.
 */
function settleProcess(proc: ChildProcess): Promise<void> {
  // A Windows root PID can be reused after exit, even while inherited pipes
  // delay close. The spawn owner's bounded drain releases those pipes safely.
  if (process.platform === "win32" && (proc.exitCode != null || proc.signalCode != null)) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    let settled = false;
    let processSettled = false;
    let graceElapsed = false;
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    const settle = () => {
      if (settled) {
        return;
      }
      settled = true;
      if (graceTimer) {
        clearTimeout(graceTimer);
      }
      if (finalTimeout) {
        clearTimeout(finalTimeout);
      }
      proc.removeListener("exit", settleAfterEscalation);
      proc.removeListener("close", settleAfterEscalation);
      proc.removeListener("error", settleAfterEscalation);
      resolve();
    };
    const settleAfterEscalation = () => {
      processSettled = true;
      if (graceElapsed) {
        settle();
      }
    };
    const finalTimeout = setTimeout(() => {
      if (!settled) {
        log.warn("gog process did not exit after SIGKILL; giving up");
        settle();
      }
    }, 8_000);

    proc.on("exit", settleAfterEscalation);
    proc.on("close", settleAfterEscalation);
    proc.on("error", settleAfterEscalation);

    // killProcessTree sends SIGTERM to the process group (Unix) or uses taskkill /T
    // (Windows) and escalates to SIGKILL after graceMs, reaching any descendants
    // spawned by gog that plain proc.kill() would miss.
    if (typeof proc.pid === "number") {
      const graceMs = 3_000;
      killProcessTree(proc.pid, {
        graceMs,
        detached: process.platform !== "win32",
      });
      // killProcessTree owns escalation but intentionally unrefs its timer.
      // Keep shutdown referenced until that escalation has had a chance to run.
      graceTimer = setTimeout(() => {
        graceElapsed = true;
        if (processSettled) {
          settle();
        }
      }, graceMs + 25);
    } else {
      // pid absent means spawn never started; direct kill clears any lingering state.
      try {
        proc.kill("SIGTERM");
      } catch {
        /* process may not exist */
      }
      graceElapsed = true;
    }
  });
}

async function stopWatcherResources(onProcessStop?: () => void): Promise<void> {
  shuttingDown = true;
  if (respawnTimeout) {
    clearTimeout(respawnTimeout);
    respawnTimeout = null;
  }
  const renewal = renewalScope;
  await renewal?.stop();
  if (renewalScope === renewal) {
    renewalScope = undefined;
  }
  if (watcherProcess) {
    onProcessStop?.();
    const proc = watcherProcess;
    watcherProcess = null;
    await settleProcess(proc);
  }
}

type GmailWatcherStartResult = {
  started: boolean;
  reason?: string;
};

type GmailWatcherStartOptions = {
  signal?: AbortSignal;
  scheduler: GatewayScheduler;
  prepareGog?: (inspection: GogInspection, signal?: AbortSignal) => Promise<GogInspection>;
};

function cancelledGmailWatcherStart(
  expectedConfig: GmailHookRuntimeConfig,
): GmailWatcherStartResult {
  if (currentConfig === expectedConfig) {
    currentConfig = null;
  }
  return { started: false, reason: "startup cancelled" };
}

export async function startGmailWatcher(
  cfg: OpenClawConfig,
  options: GmailWatcherStartOptions,
): Promise<GmailWatcherStartResult> {
  if (!cfg.hooks?.enabled) {
    return { started: false, reason: "hooks not enabled" };
  }

  if (!cfg.hooks?.gmail?.account) {
    return { started: false, reason: "no gmail account configured" };
  }

  if (!hasBinary("gog")) {
    return { started: false, reason: "gog binary not found" };
  }

  const resolved = resolveGmailHookRuntimeConfig(cfg, {});
  if (!resolved.ok) {
    return { started: false, reason: resolved.error };
  }

  return startGmailWatcherService(resolved.value, options);
}

/** Start the shared watcher lifecycle after the caller resolves config and prerequisites. */
export async function startGmailWatcherService(
  runtimeConfig: GmailHookRuntimeConfig,
  options: GmailWatcherStartOptions,
): Promise<GmailWatcherStartResult> {
  if (options.signal?.aborted) {
    return cancelledGmailWatcherStart(runtimeConfig);
  }
  currentConfig = runtimeConfig;

  // Stop any existing watcher before doing async setup so a re-entry
  // does not orphan the old serve process or leave a dangling timer.
  // This must run before Tailscale/watch-start to prevent the old
  // process from exiting and queuing a respawn during async work.
  if (watcherProcess || renewalScope || respawnTimeout) {
    await stopWatcherResources();
    shuttingDown = false;
  }

  let inspection: GogInspection;
  try {
    inspection = await inspectGog({ signal: options.signal });
    if (currentConfig !== runtimeConfig || options.signal?.aborted) {
      return cancelledGmailWatcherStart(runtimeConfig);
    }
    if (inspection.support !== "supported" && options.prepareGog) {
      inspection = await options.prepareGog(inspection, options.signal);
    }
  } catch (err) {
    if (options.signal?.aborted || currentConfig !== runtimeConfig) {
      return cancelledGmailWatcherStart(runtimeConfig);
    }
    throw err;
  }
  if (currentConfig !== runtimeConfig || options.signal?.aborted) {
    return cancelledGmailWatcherStart(runtimeConfig);
  }
  const executable = inspection.executable;
  if (!executable) {
    currentConfig = null;
    return { started: false, reason: "gog binary not found; install Gog and restart the watcher" };
  }
  const transport: GmailTokenTransport = inspection.support === "supported" ? "env" : "legacy-argv";

  if (runtimeConfig.tailscale.mode !== "off") {
    try {
      await ensureTailscaleEndpoint({
        mode: runtimeConfig.tailscale.mode,
        path: runtimeConfig.tailscale.path,
        port: runtimeConfig.serve.port,
        signal: options.signal,
        target: runtimeConfig.tailscale.target,
      });
      log.info(
        `tailscale ${runtimeConfig.tailscale.mode} configured for port ${runtimeConfig.serve.port}`,
      );
      if (options.signal?.aborted || currentConfig !== runtimeConfig) {
        return cancelledGmailWatcherStart(runtimeConfig);
      }
    } catch (err) {
      if (options.signal?.aborted) {
        return cancelledGmailWatcherStart(runtimeConfig);
      }
      log.error(`tailscale setup failed: ${String(err)}`);
      return {
        started: false,
        reason: `tailscale setup failed: ${String(err)}`,
      };
    }
  }

  const watchStarted = await startGmailWatch(runtimeConfig, executable, { signal: options.signal });
  if (options.signal?.aborted || currentConfig !== runtimeConfig) {
    return cancelledGmailWatcherStart(runtimeConfig);
  }
  if (!watchStarted) {
    log.warn("gmail watch start failed, but continuing with serve");
  }

  shuttingDown = false;
  if (transport === "legacy-argv") {
    log.warn(
      `${inspection.support === "indeterminate" ? "Could not verify Gog token environment support. " : "Selected Gog lacks token environment support. "}${GMAIL_INSECURE_TOKEN_ARGS_WARNING}`,
    );
  }
  watcherProcess = spawnGogServe(runtimeConfig, executable, transport);
  const renewMs = runtimeConfig.renewEveryMinutes * 60_000;
  const renewal = options.scheduler.scope();
  renewalScope = renewal;
  // A failed start or renewal retries with capped backoff instead of waiting a full renewal
  // interval; Gmail stops pushing once a watch is 7 days old or was never established.
  // Rescheduling the same id replaces a pending retry, so only one retry chain exists.
  const retryBackoff = { ...GMAIL_WATCH_RETRY_BACKOFF, maxMs: renewMs };
  let retry: GatewayScheduledJob | undefined;
  const scheduleRetry = (attempt: number) => {
    retry = renewal.schedule({
      id: "gmail-watch-retry",
      delayMs: computeBackoff(retryBackoff, attempt),
      run: () => renewWatch(attempt + 1),
    });
  };
  // One start at a time: a renewal that comes due while a retry runs joins it.
  let inFlight: Promise<void> | undefined;
  const renewWatch = (attempt: number) =>
    (inFlight ??= (async () => {
      try {
        if (!(await startGmailWatch(runtimeConfig, executable, { signal: renewal.signal }))) {
          scheduleRetry(attempt);
        }
      } finally {
        inFlight = undefined;
      }
    })());
  renewal.schedule({
    id: "gmail-watch-renewal",
    delayMs: renewMs,
    everyMs: renewMs,
    run: () => {
      retry?.cancel();
      return renewWatch(1);
    },
  });
  if (!watchStarted) {
    scheduleRetry(1);
  }

  log.info(
    `gmail watcher started for ${runtimeConfig.account} (renew every ${runtimeConfig.renewEveryMinutes}m)`,
  );

  return { started: true };
}

export async function stopGmailWatcher(): Promise<void> {
  await stopWatcherResources(() => log.info("stopping gmail watcher"));

  currentConfig = null;
  log.info("gmail watcher stopped");
}
