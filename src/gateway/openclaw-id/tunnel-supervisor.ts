// Supervises the OpenClaw ID tunnel child: one forked Node process that owns
// the iroh endpoint key and proxies streams to the Gateway. Process model
// (tailcat-spike docs/iroh/process-model.md): control over IPC, restart with
// 1 -> 30 s backoff, lower CPU priority, health pings, an RSS watchdog that
// restarts gracefully, and SIGTERM then SIGKILL after 2 s on stop. A child
// that reports the transport unavailable is not crash-restarted; the Gateway
// runs on and probes again every minute, so status recovers once the iroh
// binding is installed or rebuilt.
import { fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import os from "node:os";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import type { BoundKeyRefusal } from "./tunnel-child/keyfile.js";
import {
  parseTunnelToGatewayMessage,
  TUNNEL_EXIT_KEY_MISMATCH,
  TUNNEL_EXIT_KEY_MISSING,
  TUNNEL_EXIT_KEY_REFUSED,
  TUNNEL_EXIT_UNAVAILABLE,
  type GatewayToTunnelMessage,
  type TunnelReadyMessage,
  type TunnelStartMessage,
} from "./tunnel-ipc.js";

/** Timing and limits; tests shorten them. */
export type TunnelSupervisorTuning = {
  backoffInitialMs: number;
  backoffMaxMs: number;
  /** A child up this long resets the backoff. */
  healthyResetMs: number;
  /** Consecutive failed starts before status reports crash looping. */
  crashLoopAfter: number;
  readyTimeoutMs: number;
  pingIntervalMs: number;
  /** No pong for this long: the child is hung and gets SIGKILL. */
  pingTimeoutMs: number;
  /** SIGTERM grace before SIGKILL. */
  shutdownGraceMs: number;
  /** RSS above this restarts the child gracefully. */
  maxRssBytes: number;
  /** Added to the Gateway's niceness for the child (best effort). */
  niceIncrement: number;
  /** After the transport reported itself unavailable, wait this long before probing again. */
  unavailableRetryMs: number;
};

const DEFAULT_TUNNEL_SUPERVISOR_TUNING: TunnelSupervisorTuning = {
  backoffInitialMs: 1_000,
  backoffMaxMs: 30_000,
  healthyResetMs: 60_000,
  crashLoopAfter: 5,
  readyTimeoutMs: 30_000,
  pingIntervalMs: 5_000,
  pingTimeoutMs: 15_000,
  shutdownGraceMs: 2_000,
  maxRssBytes: 512 * 1024 * 1024,
  niceIncrement: 10,
  unavailableRetryMs: 60_000,
};

/** Supervisor status as shown to operators. */
export type TunnelSupervisorStatus =
  | { state: "stopped" }
  | { state: "starting"; restarts: number }
  | {
      state: "running";
      endpointKey: string;
      relayUrl: string;
      relayOnline: boolean;
      /** The relay's reason when it refused this claw's endpoint; null otherwise. */
      relayDenied: string | null;
      connections: number;
      restarts: number;
    }
  | {
      state: "backoff";
      retryInMs: number;
      restarts: number;
      crashLooping: boolean;
      lastExit: string;
    }
  /** `retryInMs` is set while the supervisor waits to probe the transport again. */
  | { state: "unavailable"; reason: string; retryInMs?: number }
  /** No file holds the endpoint key the claw is bound to. Not retried. */
  | { state: "key_refused"; reason: BoundKeyRefusal };

/** How to launch the child: an entry module and the Node arguments that run it. */
export type TunnelChildLaunch = { entry: URL; execArgv: string[] };

type SupervisorLogger = { info: (message: string) => void; warn: (message: string) => void };

/** Creates a stopped supervisor; `start` launches the child. */
export function createTunnelSupervisor(params: {
  launch: TunnelChildLaunch;
  /** Builds the start message for each (re)start, so a restart picks up current settings. */
  startMessage: () => TunnelStartMessage;
  log: SupervisorLogger;
  env?: NodeJS.ProcessEnv;
  tuning?: Partial<TunnelSupervisorTuning>;
  onReady?: (ready: TunnelReadyMessage) => void;
  onStatus?: (status: TunnelSupervisorStatus) => void;
}) {
  const tuning = { ...DEFAULT_TUNNEL_SUPERVISOR_TUNING, ...params.tuning };
  let status: TunnelSupervisorStatus = { state: "stopped" };
  let child: ChildProcess | undefined;
  let wanted = false;
  let failures = 0;
  let restarts = 0;
  let retryTimer: NodeJS.Timeout | undefined;
  let lastMembership: GatewayToTunnelMessage | undefined;

  const setStatus = (next: TunnelSupervisorStatus) => {
    status = next;
    params.onStatus?.(next);
  };

  // Delay before the next start: 1 s doubling to 30 s per consecutive failure.
  const backoffMs = () =>
    Math.min(tuning.backoffMaxMs, tuning.backoffInitialMs * 2 ** Math.max(0, failures - 1));

  // Schedules a restart after an unplanned exit (or immediately after a planned recycle).
  const scheduleRestart = (lastExit: string, immediate: boolean) => {
    if (!wanted) {
      setStatus({ state: "stopped" });
      return;
    }
    const retryInMs = immediate ? 0 : backoffMs();
    setStatus({
      state: "backoff",
      retryInMs,
      restarts,
      crashLooping: failures >= tuning.crashLoopAfter,
      lastExit,
    });
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      launch();
    }, retryInMs);
    retryTimer.unref();
  };

  // Forks one child and wires IPC, logs, health and exit handling.
  const launch = () => {
    const entryPath = fileURLToPath(params.launch.entry);
    if (!existsSync(entryPath)) {
      wanted = false;
      setStatus({
        state: "unavailable",
        reason: "tunnel child entry is missing from this install",
      });
      return;
    }
    setStatus({ state: "starting", restarts });
    const proc = fork(entryPath, [], {
      execArgv: params.launch.execArgv,
      env: params.env ?? process.env,
      serialization: "advanced",
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    child = proc;
    lowerPriority(proc, tuning.niceIncrement);
    pipeLines(proc, params.log);

    const startedAt = Date.now();
    let ready = false;
    let recycling = false;
    let lastPongAt = Date.now();
    let pingId = 0;
    const timers: NodeJS.Timeout[] = [];
    const addTimer = (timer: NodeJS.Timeout) => {
      timer.unref();
      timers.push(timer);
    };

    // Asks the child to exit; SIGKILL if it outlives the grace period.
    const terminate = () => {
      if (proc.exitCode !== null || proc.signalCode !== null) {
        return;
      }
      proc.kill("SIGTERM");
      addTimer(setTimeout(() => proc.kill("SIGKILL"), tuning.shutdownGraceMs));
    };

    addTimer(
      setTimeout(() => {
        if (!ready) {
          params.log.warn("openclaw-id: tunnel child did not become ready; killing it");
          proc.kill("SIGKILL");
        }
      }, tuning.readyTimeoutMs),
    );
    addTimer(
      setInterval(() => {
        if (!ready) {
          return;
        }
        if (Date.now() - lastPongAt > tuning.pingTimeoutMs) {
          params.log.warn("openclaw-id: tunnel child stopped answering health pings; killing it");
          proc.kill("SIGKILL");
          return;
        }
        send(proc, { type: "ping", id: ++pingId });
      }, tuning.pingIntervalMs),
    );

    proc.on("message", (raw) => {
      const message = parseTunnelToGatewayMessage(raw);
      if (!message) {
        return;
      }
      if (message.type === "ready") {
        ready = true;
        lastPongAt = Date.now();
        setStatus({
          state: "running",
          endpointKey: message.endpointKey,
          relayUrl: message.relayUrl,
          relayOnline: false,
          relayDenied: null,
          connections: 0,
          restarts,
        });
        if (lastMembership) {
          send(proc, lastMembership);
        }
        params.onReady?.(message);
        return;
      }
      if (message.type === "pong") {
        lastPongAt = Date.now();
        if (message.rssBytes > tuning.maxRssBytes && !recycling) {
          recycling = true;
          params.log.warn(
            `openclaw-id: tunnel child RSS ${Math.round(message.rssBytes / 1048576)} MB is over the limit; restarting it`,
          );
          terminate();
        }
        return;
      }
      if (status.state === "running") {
        setStatus({
          ...status,
          relayOnline: message.relayOnline,
          relayDenied: message.relayDenied ?? null,
          connections: message.connections,
        });
      }
    });

    proc.once("error", (error) => {
      params.log.warn(`openclaw-id: tunnel child error: ${error.message}`);
    });

    proc.once("exit", (code, signal) => {
      for (const timer of timers) {
        clearTimeout(timer);
      }
      if (child === proc) {
        child = undefined;
      }
      const lastExit = signal ? `signal ${signal}` : `exit code ${code}`;
      if (code === TUNNEL_EXIT_UNAVAILABLE && wanted) {
        // Not a crash: the binding is missing. Probe again later instead of backing off.
        setStatus({
          state: "unavailable",
          reason: "iroh transport is unavailable on this platform",
          retryInMs: tuning.unavailableRetryMs,
        });
        params.log.warn(
          "openclaw-id: iroh transport unavailable; remote access is off, the Gateway keeps running",
        );
        retryTimer = setTimeout(() => {
          retryTimer = undefined;
          launch();
        }, tuning.unavailableRetryMs);
        retryTimer.unref();
        return;
      }
      if (code === TUNNEL_EXIT_KEY_MISSING || code === TUNNEL_EXIT_KEY_MISMATCH) {
        wanted = false;
        const reason = code === TUNNEL_EXIT_KEY_MISSING ? "keys_missing" : "key_mismatch";
        setStatus({ state: "key_refused", reason });
        params.log.warn(
          `openclaw-id: endpoint key refused (${reason}); remote access is off, the Gateway keeps running. Restore the original key file, then restart the Gateway`,
        );
        return;
      }
      if (code === TUNNEL_EXIT_KEY_REFUSED) {
        wanted = false;
        setStatus({ state: "unavailable", reason: "endpoint key file is unsafe or corrupt" });
        params.log.warn(
          "openclaw-id: endpoint key refused; fix or remove the key file (a new key re-links every device)",
        );
        return;
      }
      if (!wanted) {
        setStatus({ state: "stopped" });
        return;
      }
      restarts += 1;
      // A recycle (RSS limit) is planned and not a failure. A child that was healthy
      // long enough resets the backoff; anything else counts as a failure.
      if (recycling) {
        failures = 0;
      } else if (ready && Date.now() - startedAt >= tuning.healthyResetMs) {
        failures = 1;
      } else {
        failures += 1;
      }
      if (!recycling) {
        params.log.warn(`openclaw-id: tunnel child exited (${lastExit}); restarting`);
      }
      scheduleRestart(lastExit, recycling);
    });

    send(proc, params.startMessage());
  };

  return {
    /** Starts the child if it is not already running. */
    start(): void {
      if (wanted) {
        return;
      }
      wanted = true;
      failures = 0;
      launch();
    },
    /** Pushes the admitted peer keys now and after every restart. */
    pushMembership(seq: number, admitted: string[]): void {
      lastMembership = { type: "membership", seq, admitted };
      if (child && status.state === "running") {
        send(child, lastMembership);
      }
    },
    /** Stops the child: SIGTERM, then SIGKILL after the grace period. */
    async stop(): Promise<void> {
      wanted = false;
      if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = undefined;
      }
      const proc = child;
      if (!proc || proc.exitCode !== null || proc.signalCode !== null) {
        setStatus({ state: "stopped" });
        return;
      }
      const exited = once(proc, "exit");
      proc.kill("SIGTERM");
      const killTimer = setTimeout(() => proc.kill("SIGKILL"), tuning.shutdownGraceMs);
      await exited;
      clearTimeout(killTimer);
    },
    /** Current status. */
    status(): TunnelSupervisorStatus {
      return status;
    },
  };
}

export type TunnelSupervisor = ReturnType<typeof createTunnelSupervisor>;

// IPC send that tolerates a child that already went away.
function send(proc: ChildProcess, message: GatewayToTunnelMessage): void {
  if (proc.connected) {
    proc.send(message, (error) => {
      // A closed channel means the child is exiting; its exit handler owns recovery.
      void error;
    });
  }
}

// Runs the child below the Gateway's CPU priority; unsupported hosts keep the default.
function lowerPriority(proc: ChildProcess, increment: number): void {
  if (proc.pid === undefined) {
    return;
  }
  try {
    os.setPriority(proc.pid, Math.min(19, os.getPriority() + increment));
  } catch {
    // Best effort: some containers forbid priority changes.
  }
}

// Copies child stdout/stderr lines into the Gateway log with a prefix.
function pipeLines(proc: ChildProcess, log: SupervisorLogger): void {
  for (const [stream, write] of [
    [proc.stdout, log.info],
    [proc.stderr, log.warn],
  ] as const) {
    if (stream) {
      createInterface({ input: stream }).on("line", (line) => write(`tunnel: ${line}`));
    }
  }
}
