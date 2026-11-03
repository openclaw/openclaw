import { type ChildProcess, spawn } from "node:child_process";
import process from "node:process";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { computeBackoff } from "../infra/backoff.js";
import type { GatewayScheduler, GatewaySchedulerScope } from "../infra/gateway-scheduler.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { releaseChildProcessOutputAfterExit } from "../process/child-process.js";
import { formatCommandResult } from "../process/command-error.js";
import { runCommandWithTimeout, runUtf8CommandWithTimeout } from "../process/exec.js";
import { killProcessTree } from "../process/kill-tree.js";
import { hasBinary } from "../skills/loading/config.js";
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
  resolveGogExecutable,
  resolveGogServeInvocation,
  resolveGmailHookRuntimeConfig,
} from "./gmail.js";

const log = createSubsystemLogger("gmail-watcher");
const GMAIL_WATCHER_STDERR_TAIL_CHARS = 512;
const GMAIL_BIND_RETRY_LIMIT = 3;
const GMAIL_BIND_BACKOFF = { initialMs: 5_000, maxMs: 20_000, factor: 2, jitter: 0 };

let watcherProcess: ChildProcess | null = null;
let renewalScope: GatewaySchedulerScope | undefined;
let shuttingDown = false;
let currentConfig: GmailHookRuntimeConfig | null = null;
let respawnTimeout: ReturnType<typeof setTimeout> | null = null;

async function probeGogTokenEnv(
  signal?: AbortSignal,
): Promise<"supported" | "unsupported" | "indeterminate"> {
  try {
    const invocation = resolveGogServeInvocation([
      "--json",
      "--no-input",
      "schema",
      "gmail",
      "watch",
      "serve",
    ]);
    const result = await runUtf8CommandWithTimeout([invocation.command, ...invocation.args], {
      timeoutMs: 5_000,
      signal,
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
      maxOutputBytes: { stdout: 256 * 1024, stderr: 16 * 1024 },
      maxCombinedOutputBytes: 272 * 1024,
      terminateOnOutputLimit: true,
    });
    if (
      result.code !== 0 ||
      result.signal !== null ||
      result.termination !== "exit" ||
      result.outputLimitExceeded ||
      result.stdoutTruncatedBytes ||
      result.stderrTruncatedBytes
    ) {
      return "indeterminate";
    }
    const schema: unknown = JSON.parse(result.stdout);
    if (
      !isRecord(schema) ||
      schema.schema_version !== 1 ||
      !isRecord(schema.command) ||
      schema.command.type !== "command" ||
      schema.command.name !== "serve" ||
      !Array.isArray(schema.command.flags)
    ) {
      return "indeterminate";
    }
    const flags = new Map<string, unknown>();
    for (const flag of schema.command.flags) {
      if (!isRecord(flag) || typeof flag.name !== "string" || flags.has(flag.name)) {
        return "indeterminate";
      }
      flags.set(flag.name, flag.type);
    }
    if (
      flags.get("token") !== "string" ||
      flags.get("hook-token") !== "string" ||
      ["token-env", "hook-token-env"].some(
        (name) => flags.has(name) && flags.get(name) !== "string",
      )
    ) {
      return "indeterminate";
    }
    return flags.has("token-env") && flags.has("hook-token-env") ? "supported" : "unsupported";
  } catch {
    // Schema diagnostics can contain local configuration; report only the failed check.
    return "indeterminate";
  }
}

async function startGmailWatch(
  cfg: Pick<GmailHookRuntimeConfig, "account" | "label" | "topic">,
  options: { signal?: AbortSignal } = {},
): Promise<boolean> {
  const args = [resolveGogExecutable(), ...buildGogWatchStartArgs(cfg)];
  try {
    const result = await runCommandWithTimeout(args, {
      timeoutMs: 120_000,
      signal: options.signal,
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
  transport: GmailTokenTransport,
  onFatalError?: (reason: string) => void,
  bindRetries = 0,
): ChildProcess {
  const args = buildGogWatchServeArgs(cfg, transport);
  log.info(`starting gog ${buildGogWatchServeLogArgs(cfg, transport).join(" ")}`);
  if (transport === "legacy-argv") {
    log.warn(GMAIL_INSECURE_TOKEN_ARGS_WARNING);
  }
  let addressInUse = false;
  let runtimeCrash = false;
  let spawnFailed = false;
  // Carry a bounded tail so bind markers split across stderr chunks survive until close.
  let stderrTail = "";
  const invocation = resolveGogServeInvocation(args);

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
    if (/^(?:panic|fatal error): /m.test(combined)) {
      runtimeCrash = true;
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
      onFatalError?.(
        "Gog could not start; check the gog installation and restart the Gmail watcher.",
      );
      return;
    }
    if (code === 2 && !runtimeCrash && !addressInUse) {
      watcherProcess = null;
      currentConfig = null;
      const renewal = renewalScope;
      renewalScope = undefined;
      renewal?.beginClose();
      const reason =
        "Gog rejected the serve configuration; check its preceding diagnostic and install a build supporting --token-env and --hook-token-env, then restart the Gmail watcher.";
      log.error(reason);
      onFatalError?.(reason);
      void renewal
        ?.stop()
        .catch((err: unknown) => log.error(`gmail renewal cleanup failed: ${String(err)}`));
      return;
    }
    if (addressInUse && bindRetries >= GMAIL_BIND_RETRY_LIMIT) {
      log.error(
        `gog serve failed to bind after ${GMAIL_BIND_RETRY_LIMIT} retries (address already in use); stopping restarts. ` +
          "Stop the other process and restart the Gmail watcher, or set OPENCLAW_SKIP_GMAIL_WATCHER=1 if it is managed separately.",
      );
      watcherProcess = null;
      onFatalError?.(
        "Gog could not bind after three retries; stop the conflicting listener and restart the Gmail watcher.",
      );
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
      watcherProcess = spawnGogServe(cfg, transport, onFatalError, nextBindRetries);
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
  confirmInsecureTokenArgs?: () => Promise<boolean>;
  onFatalError?: (reason: string) => void;
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

  const support = await probeGogTokenEnv(options.signal);
  if (currentConfig !== runtimeConfig || options.signal?.aborted) {
    return cancelledGmailWatcherStart(runtimeConfig);
  }
  if (support === "indeterminate") {
    currentConfig = null;
    return {
      started: false,
      reason:
        "Gog compatibility check failed. Check `gog --json --no-input schema gmail watch serve` or upgrade Gog, then restart the Gmail watcher. No legacy launch was attempted.",
    };
  }
  let transport: GmailTokenTransport = "env";
  if (support === "unsupported") {
    const consent =
      runtimeConfig.allowInsecureTokenArgs || (await options.confirmInsecureTokenArgs?.());
    if (currentConfig !== runtimeConfig || options.signal?.aborted) {
      return cancelledGmailWatcherStart(runtimeConfig);
    }
    if (consent !== true) {
      currentConfig = null;
      return {
        started: false,
        reason:
          "Upgrade Gog to support --token-env and --hook-token-env. Legacy arguments require foreground confirmation or explicit hooks.gmail.allowInsecureTokenArgs=true (exposes both tokens to local users).",
      };
    }
    transport = "legacy-argv";
  }

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
      if (options.signal?.aborted) {
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

  const watchStarted = await startGmailWatch(runtimeConfig, { signal: options.signal });
  if (options.signal?.aborted || currentConfig !== runtimeConfig) {
    return cancelledGmailWatcherStart(runtimeConfig);
  }
  if (!watchStarted) {
    log.warn("gmail watch start failed, but continuing with serve");
  }

  shuttingDown = false;
  watcherProcess = spawnGogServe(runtimeConfig, transport, options.onFatalError);
  const renewMs = runtimeConfig.renewEveryMinutes * 60_000;
  const renewal = options.scheduler.scope();
  renewalScope = renewal;
  renewal.schedule({
    id: "gmail-watch-renewal",
    delayMs: renewMs,
    everyMs: renewMs,
    run: () => startGmailWatch(runtimeConfig, { signal: renewal.signal }),
  });

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
