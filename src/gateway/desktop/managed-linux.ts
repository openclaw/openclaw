import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { sleepWithAbort } from "@openclaw/retry";
import { tryListenOnPort } from "../../infra/ports-probe.js";
import { registerSecretValueForRedaction } from "../../logging/secret-redaction-registry.js";
import { runCommandBuffered } from "../../process/exec.js";
import { getProcessSupervisor } from "../../process/supervisor/index.js";
import type { ManagedRun, ProcessSupervisor, RunExit } from "../../process/supervisor/types.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { getHostDesktopGuidance } from "./host-guidance.js";
import {
  createManagedLinuxAudio,
  managedLinuxAudioEnv,
  type DesktopAudioSource,
  type ManagedLinuxAudio,
} from "./managed-linux-audio.js";
import { probeRfbServer } from "./rfb-probe.js";

const MANAGED_DISPLAY_FIRST = 99;
const MANAGED_DISPLAY_LAST = 199;
const MANAGED_RESTART_LIMIT = 3;
const MANAGED_RESTART_WINDOW_MS = 5 * 60_000;
const AUDIO_RESTART_LIMIT = 3;
const AUDIO_RESTART_WINDOW_MS = 5 * 60_000;
const MANAGED_READINESS_TIMEOUT_MS = 15_000;
const MANAGED_READINESS_POLL_MS = 100;
const STDERR_TAIL_CHARS = 4_096;

type ManagedResources = {
  tempDir: string;
  passwordFile: string;
  password: string;
  display: number;
  port: number;
  env: NodeJS.ProcessEnv;
};

type ManagedPair = {
  current: boolean;
  vnc: ManagedRun;
  bus: ManagedRun;
  session: ManagedRun;
  vncExit: ReturnType<ManagedRun["wait"]>;
  busExit: ReturnType<ManagedRun["wait"]>;
  sessionExit: ReturnType<ManagedRun["wait"]>;
  computerLeases: Set<{ onStop(): Promise<void> }>;
  audio: ManagedLinuxAudio;
  env: NodeJS.ProcessEnv;
  stopPromise?: Promise<void>;
};

export type DesktopComputerLease = {
  env: NodeJS.ProcessEnv;
  isCurrent(): boolean;
  release(): void;
};

export type ManagedLinuxDesktopStatus =
  | { state: "not-started" }
  | { state: "starting"; display?: number; port?: number }
  | { state: "running"; display: number; port: number }
  | { state: "failed"; error: string; display?: number; port?: number };

export type ManagedLinuxDesktop = {
  acquire(): Promise<{
    attachment: { kind: "tcp"; host: "127.0.0.1"; port: number };
    auth: "vnc-password";
    vncPassword: string;
    resolveAudio?: () => DesktopAudioSource | undefined;
    audioUnavailableReason?: string;
  }>;
  acquireComputer(params: { onStop(): Promise<void> }): Promise<DesktopComputerLease>;
  stop(): Promise<void>;
  status(): ManagedLinuxDesktopStatus;
};

function buildTigerVncArgv(resources: ManagedResources): string[] {
  return [
    "Xtigervnc",
    `:${resources.display}`,
    "-geometry",
    "1920x1080",
    "-depth",
    "24",
    "-localhost",
    "yes",
    "-rfbport",
    String(resources.port),
    "-SecurityTypes",
    "VncAuth",
    "-PasswordFile",
    resources.passwordFile,
    "-AlwaysShared",
    "-AcceptSetDesktopSize",
    "-nolisten",
    "tcp",
    "-ac",
  ];
}

function chooseDisplayNumber(socketNames: readonly string[]): number {
  const occupied = new Set(
    socketNames.flatMap((name) => {
      const match = /^X(\d+)$/u.exec(name);
      return match ? [Number.parseInt(match[1] ?? "", 10)] : [];
    }),
  );
  for (let display = MANAGED_DISPLAY_FIRST; display <= MANAGED_DISPLAY_LAST; display += 1) {
    if (!occupied.has(display)) {
      return display;
    }
  }
  throw new Error(
    `managed Linux desktop could not find an unused X display between :${MANAGED_DISPLAY_FIRST} and :${MANAGED_DISPLAY_LAST}`,
  );
}

function appendTail(current: string, chunk: string): string {
  const next = current + chunk;
  return next.length <= STDERR_TAIL_CHARS ? next : next.slice(-STDERR_TAIL_CHARS);
}

function lastStderrLine(stderr: string): string | undefined {
  const lines = stderr.split(/\r?\n/u);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]?.trim();
    if (line) {
      return line;
    }
  }
  return undefined;
}

async function readDisplaySocketNames(socketDir: string): Promise<string[]> {
  try {
    return await fs.readdir(socketDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

function binaryError(
  binary: "Xtigervnc" | "tigervncpasswd" | "startxfce4" | "dbus-daemon",
  error: unknown,
) {
  const reason = error instanceof Error ? error.message : String(error);
  return new Error(
    `managed Linux desktop could not start ${binary}: ${reason}. ${getHostDesktopGuidance("linux")}`,
    { cause: error },
  );
}

export function createManagedLinuxDesktop(
  params: {
    supervisor?: ProcessSupervisor;
    onFailed?: (error: string) => void;
    runtime?: {
      createAudio?: typeof createManagedLinuxAudio;
      nowMs?: () => number;
      probeRfb?: typeof probeRfbServer;
      randomBytes?: typeof crypto.randomBytes;
      readinessPollMs?: number;
      readinessTimeoutMs?: number;
      runPasswordTool?: typeof runCommandBuffered;
      sleep?: (ms: number) => Promise<void>;
      tempRoot?: string;
      tryListenOnPort?: (params: {
        port: 0;
        host: "127.0.0.1";
        exclusive: true;
      }) => Promise<number>;
      x11SocketDir?: string;
    };
  } = {},
): ManagedLinuxDesktop {
  const supervisor = params.supervisor ?? getProcessSupervisor();
  const nowMs = params.runtime?.nowMs ?? Date.now;
  const createAudio = params.runtime?.createAudio ?? createManagedLinuxAudio;
  const probeRfb = params.runtime?.probeRfb ?? probeRfbServer;
  const randomBytes = params.runtime?.randomBytes ?? crypto.randomBytes;
  const readinessPollMs = params.runtime?.readinessPollMs ?? MANAGED_READINESS_POLL_MS;
  const readinessTimeoutMs = params.runtime?.readinessTimeoutMs ?? MANAGED_READINESS_TIMEOUT_MS;
  const runPasswordTool = params.runtime?.runPasswordTool ?? runCommandBuffered;
  // ref:false keeps readiness polling from pinning an otherwise idle process alive.
  const wait =
    params.runtime?.sleep ?? ((ms: number) => sleepWithAbort(ms, undefined, { ref: false }));
  const tempRoot = params.runtime?.tempRoot ?? os.tmpdir();
  const pickPort = params.runtime?.tryListenOnPort ?? tryListenOnPort;
  const x11SocketDir = params.runtime?.x11SocketDir ?? "/tmp/.X11-unix";
  const scopeKey = `host-desktop-managed-linux:${crypto.randomUUID()}`;

  let status: ManagedLinuxDesktopStatus = { state: "not-started" };
  let resources: ManagedResources | undefined;
  let pair: ManagedPair | undefined;
  let startPromise: Promise<ManagedResources> | undefined;
  let stopPromise: Promise<void> | undefined;
  let stopProcesses: (() => Promise<void>) | undefined;
  let audioOwner: ReturnType<typeof createManagedLinuxAudio> | undefined;
  let epoch = 0;
  let stopping = false;
  let stderrTail = "";
  let restartTimes: number[] = [];
  let audioRestartTimes: number[] = [];
  const activeWaits = new Set<Promise<RunExit>>();
  const monitorTasks = new Set<Promise<void>>();
  const isPairCurrent = (current: ManagedPair) =>
    !stopping &&
    pair === current &&
    current.current &&
    !current.vnc.activity.resultSettled &&
    !current.bus.activity.resultSettled &&
    !current.session.activity.resultSettled;

  const publicResult = (active: ManagedResources) => ({
    attachment: {
      kind: "tcp" as const,
      host: "127.0.0.1" as const,
      port: active.port,
    },
    auth: "vnc-password" as const,
    vncPassword: active.password,
    // Registry acquisitions outlive a process restart. Resolve the new generation's
    // capability at observation time; a previously captured source stays retired.
    resolveAudio: () => {
      if (resources !== active) {
        return undefined;
      }
      if (!pair || !isPairCurrent(pair)) {
        throw new Error("managed Linux desktop is restarting; retry when it is ready");
      }
      return pair.audio.source;
    },
    get audioUnavailableReason() {
      return resources === active && pair && isPairCurrent(pair)
        ? pair.audio.unavailableReason
        : undefined;
    },
  });

  const removeResources = async () => {
    const current = resources;
    resources = undefined;
    if (current) {
      await fs.rm(current.tempDir, { recursive: true, force: true });
    }
  };

  const markFailed = (error: Error) => {
    const coordinates = resources
      ? { display: resources.display, port: resources.port }
      : status.state === "starting" || status.state === "failed"
        ? { display: status.display, port: status.port }
        : {};
    status = { state: "failed", error: error.message, ...coordinates };
    params.onFailed?.(error.message);
  };

  const prepareResources = async (): Promise<ManagedResources> => {
    const tempDir = await fs.mkdtemp(path.join(tempRoot, "openclaw-managed-desktop-"));
    await fs.chmod(tempDir, 0o700);
    const plaintextFile = path.join(tempDir, "password.txt");
    const passwordFile = path.join(tempDir, "passwd");
    try {
      const password = randomBytes(12).toString("base64url").slice(0, 8);
      registerSecretValueForRedaction(password);
      await fs.writeFile(plaintextFile, password, { mode: 0o600, flag: "wx" });
      const passwordInput = await fs.readFile(plaintextFile);
      const filtered = await runPasswordTool(["tigervncpasswd", "-f"], {
        input: passwordInput,
        maxOutputBytes: { stdout: 64, stderr: 4_096 },
        timeoutMs: 10_000,
      });
      if (filtered.termination !== "exit" || filtered.code !== 0 || filtered.stdout.length === 0) {
        const detail = filtered.error?.message ?? filtered.stderr.toString("utf8").trim();
        throw binaryError("tigervncpasswd", detail || `exit code ${filtered.code ?? "none"}`);
      }
      await fs.writeFile(passwordFile, filtered.stdout, { mode: 0o600, flag: "wx" });
      await fs.rm(plaintextFile, { force: true });
      const port = await pickPort({ port: 0, host: "127.0.0.1", exclusive: true });
      const display = chooseDisplayNumber(await readDisplaySocketNames(x11SocketDir));
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        DISPLAY: `:${display}`,
        DBUS_SESSION_BUS_ADDRESS: `unix:path=${path.join(tempDir, "bus")}`,
        XDG_SESSION_TYPE: "x11",
      };
      delete env.WAYLAND_DISPLAY;
      delete env.SESSION_MANAGER;
      delete env.AT_SPI_BUS_ADDRESS;
      delete env.DBUS_SESSION_BUS_PID;
      return { tempDir, passwordFile, password, display, port, env: Object.freeze(env) };
    } catch (error) {
      await fs.rm(tempDir, { recursive: true, force: true });
      throw error;
    }
  };

  const waitUntilReady = async (active: ManagedResources, activeEpoch: number) => {
    const deadline = nowMs() + readinessTimeoutMs;
    let lastProbe = "unreachable";
    for (;;) {
      if (activeEpoch !== epoch || stopping) {
        break;
      }
      const probe = await probeRfb({
        host: "127.0.0.1",
        port: active.port,
        timeoutMs: Math.min(1_000, readinessTimeoutMs),
      });
      lastProbe = probe.kind;
      if (probe.kind === "rfb" && probe.securityTypes.includes(2)) {
        return;
      }
      if (nowMs() >= deadline) {
        break;
      }
      await wait(readinessPollMs);
    }
    if (activeEpoch !== epoch || stopping) {
      throw new Error("managed Linux desktop stopped during startup");
    }
    throw new Error(
      `managed Linux desktop did not become ready on 127.0.0.1:${active.port} within ${readinessTimeoutMs}ms (last probe: ${lastProbe})`,
    );
  };

  const stopPair = (current: ManagedPair | undefined): Promise<void> => {
    if (current?.stopPromise) {
      return current.stopPromise;
    }
    if (current) {
      current.current = false;
    }
    const retiringAudio = audioOwner;
    const audioStopped = retiringAudio?.stop();
    void audioStopped?.catch(() => undefined);
    const stopped = Promise.resolve().then(async () => {
      // Native users must finish cleanup before their X11 and D-Bus session disappears.
      const outcomes = await Promise.allSettled(
        [...(current?.computerLeases ?? [])].map(async (lease) => {
          await lease.onStop();
          current?.computerLeases.delete(lease);
        }),
      );
      const failure = outcomes.find((outcome) => outcome.status === "rejected");
      // Capture admission closes with the desktop generation, before replacing its server.
      await audioStopped;
      if (audioOwner === retiringAudio) {
        audioOwner = undefined;
      }
      if (failure) {
        throw failure.reason;
      }
      supervisor.cancelScope(scopeKey, "manual-cancel");
      const cleanup = stopProcesses;
      await cleanup?.();
      await Promise.allSettled(activeWaits);
      if (stopProcesses === cleanup) {
        stopProcesses = undefined;
      }
      if (pair === current) {
        pair = undefined;
      }
    });
    if (current) {
      current.stopPromise = stopped;
      void stopped.catch(() => {
        current.stopPromise = undefined;
      });
    }
    return stopped;
  };

  const waitForRun = (run: ManagedRun): Promise<RunExit> => {
    const pending = run.wait().catch((error: unknown): RunExit => ({
      reason: "spawn-error",
      exitCode: null,
      exitSignal: null,
      durationMs: Math.max(0, nowMs() - run.startedAtMs),
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
      timedOut: false,
      noOutputTimedOut: false,
    }));
    activeWaits.add(pending);
    void pending.finally(() => activeWaits.delete(pending));
    return pending;
  };

  const spawnRun = async (
    binary: "Xtigervnc" | "startxfce4" | "dbus-daemon",
    argv: string[],
    activeEpoch: number,
    env?: NodeJS.ProcessEnv,
    onStdout?: (chunk: string) => void,
  ) => {
    try {
      return await supervisor.spawn({
        scopeKey,
        mode: "child",
        argv,
        ...(env ? { env } : {}),
        assertCurrent: () => {
          if (activeEpoch !== epoch || stopping) {
            throw new Error("managed Linux desktop stopped during startup");
          }
        },
        ...(onStdout ? { onStdout } : {}),
        stdinMode: "pipe-closed",
        maxCapturedOutputChars: STDERR_TAIL_CHARS,
        onStderr: (chunk) => {
          stderrTail = appendTail(stderrTail, chunk);
        },
      });
    } catch (error) {
      throw binaryError(binary, error);
    }
  };

  const describeExit = (binary: string, exit: Awaited<ReturnType<ManagedRun["wait"]>>) => {
    const stderr = lastStderrLine(exit.stderr) ?? lastStderrLine(stderrTail);
    return stderr ?? `${binary} exited with code ${exit.exitCode ?? "none"}`;
  };

  const startPair = async (active: ManagedResources, activeEpoch: number): Promise<ManagedPair> => {
    status = { state: "starting", display: active.display, port: active.port };
    stopProcesses = supervisor.acquireScopeCleanup(scopeKey, { processTree: "required-all" });
    const vnc = await spawnRun("Xtigervnc", buildTigerVncArgv(active), activeEpoch);
    const vncExit = waitForRun(vnc);
    try {
      await Promise.race([
        waitUntilReady(active, activeEpoch),
        vncExit.then((exit) => {
          throw new Error(describeExit("Xtigervnc", exit));
        }),
      ]);
      if (activeEpoch !== epoch || stopping) {
        throw new Error("managed Linux desktop stopped during startup");
      }
      let audioPair: ManagedPair | null = null;
      audioOwner = createAudio({
        supervisor,
        tempDir: active.tempDir,
        env: active.env,
        assertCurrent: () => {
          if (activeEpoch !== epoch || stopping || (audioPair && !isPairCurrent(audioPair))) {
            throw new Error("managed Linux desktop stopped");
          }
        },
      });
      const audio = await audioOwner.ready;
      // Route applications (including D-Bus activation) only after private audio
      // is ready. Optional setup failure preserves the pre-existing host route;
      // the capture owner never records that fallback route.
      const env = audio.source
        ? Object.freeze({ ...active.env, ...managedLinuxAudioEnv(active.tempDir) })
        : active.env;
      const busReady = createDeferredCore();
      let busOutput = "";
      await fs.rm(path.join(active.tempDir, "bus"), { force: true });
      const bus = await spawnRun(
        "dbus-daemon",
        [
          "dbus-daemon",
          "--session",
          "--nofork",
          "--nopidfile",
          "--print-address=1",
          `--address=${active.env.DBUS_SESSION_BUS_ADDRESS}`,
        ],
        activeEpoch,
        env,
        (chunk) => {
          busOutput = appendTail(busOutput, chunk);
          if (busOutput.includes("\n")) {
            busReady.resolve();
          }
        },
      );
      const busExit = waitForRun(bus);
      const busTimeout = setTimeout(
        () =>
          busReady.reject(new Error("managed Linux desktop D-Bus session did not become ready")),
        readinessTimeoutMs,
      );
      try {
        await Promise.race([
          busReady.promise,
          busExit.then((exit) => {
            throw new Error(describeExit("dbus-daemon", exit));
          }),
          vncExit.then((exit) => {
            throw new Error(describeExit("Xtigervnc", exit));
          }),
        ]);
      } finally {
        clearTimeout(busTimeout);
      }
      const session = await spawnRun("startxfce4", ["startxfce4"], activeEpoch, env);
      const nextPair: ManagedPair = {
        current: true,
        vnc,
        bus,
        session,
        vncExit,
        busExit,
        sessionExit: waitForRun(session),
        computerLeases: new Set(),
        audio,
        env,
      };
      audioPair = nextPair;
      pair = nextPair;
      status = { state: "running", display: active.display, port: active.port };
      return nextPair;
    } catch (error) {
      await stopPair(undefined);
      throw error;
    }
  };

  const monitorPair = (current: ManagedPair, active: ManagedResources, activeEpoch: number) => {
    const desktopExit = Promise.race([
      current.vncExit.then((exit) => describeExit("Xtigervnc", exit)),
      current.busExit.then((exit) => describeExit("dbus-daemon", exit)),
      current.sessionExit.then((exit) => describeExit("startxfce4", exit)),
    ]);
    const stillOwned = () => pair === current && activeEpoch === epoch && !stopping;
    const task = (async () => {
      for (;;) {
        const audio = current.audio;
        const failure = await Promise.race([
          desktopExit,
          ...(audio.failed
            ? [audio.failed.then(() => audio.unavailableReason ?? "private PulseAudio exited")]
            : []),
        ]);
        if (!stillOwned()) {
          return;
        }
        if (isPairCurrent(current) && audio.failed) {
          const disableAudio = (reason: string) => {
            const retiringAudio = audioOwner ?? audio;
            // Drop the resolved failure promise so the monitor waits for a desktop
            // exit instead of repeatedly retrying this optional capability.
            current.audio = {
              stop: () => retiringAudio.stop(),
              unavailableReason: `Managed desktop audio unavailable: ${reason}. Healthy desktop applications remain running. Check pulseaudio and pulseaudio-utils, then restart the managed desktop if audio is needed.`,
            };
          };
          try {
            // Retire captures before rebinding the same private route. Never revive
            // old sources or replace healthy applications just to restore audio.
            await audio.stop();
            if (!stillOwned()) {
              return;
            }
            if (isPairCurrent(current)) {
              const now = nowMs();
              audioRestartTimes = audioRestartTimes.filter(
                (startedAt) => now - startedAt < AUDIO_RESTART_WINDOW_MS,
              );
              if (audioRestartTimes.length >= AUDIO_RESTART_LIMIT) {
                disableAudio(`${AUDIO_RESTART_LIMIT} restarts within 5 minutes: ${failure}`);
                continue;
              }
              audioRestartTimes.push(now);
              audioOwner = createAudio({
                supervisor,
                tempDir: active.tempDir,
                env: active.env,
                assertCurrent: () => {
                  if (!stillOwned() || !isPairCurrent(current)) {
                    throw new Error("managed Linux desktop stopped");
                  }
                },
              });
              const recovered = await audioOwner.ready;
              if (!stillOwned()) {
                return;
              }
              current.audio = recovered;
              if (isPairCurrent(current)) {
                if (!recovered.source) {
                  await recovered.stop();
                  disableAudio(recovered.unavailableReason ?? "private PulseAudio recovery failed");
                }
                continue;
              }
            }
          } catch (error) {
            if (!stillOwned()) {
              return;
            }
            if (isPairCurrent(current)) {
              disableAudio(error instanceof Error ? error.message : String(error));
              continue;
            }
          }
          // Desktop loss during pending audio work alone consumes the desktop budget.
        }
        const now = nowMs();
        restartTimes = restartTimes.filter(
          (startedAt) => now - startedAt < MANAGED_RESTART_WINDOW_MS,
        );
        if (restartTimes.length >= MANAGED_RESTART_LIMIT) {
          await stopPair(current);
          if (activeEpoch === epoch && !stopping) {
            markFailed(
              new Error(
                `managed Linux desktop failed after ${MANAGED_RESTART_LIMIT} restarts within 5 minutes: ${failure}`,
              ),
            );
          }
          return;
        }
        restartTimes.push(now);
        status = { state: "starting", display: active.display, port: active.port };
        await stopPair(current);
        if (activeEpoch !== epoch || stopping) {
          return;
        }
        const restarted = await startPair(active, activeEpoch);
        monitorPair(restarted, active, activeEpoch);
        return;
      }
    })().catch(async (error: unknown) => {
      try {
        await stopPair(current);
      } finally {
        if (activeEpoch === epoch && !stopping) {
          markFailed(error instanceof Error ? error : new Error(String(error)));
        }
      }
    });
    monitorTasks.add(task);
    void task.finally(() => monitorTasks.delete(task)).catch(() => undefined);
  };

  const start = async (activeEpoch: number): Promise<ManagedResources> => {
    try {
      resources = await prepareResources();
      if (activeEpoch !== epoch || stopping) {
        throw new Error("managed Linux desktop stopped during startup");
      }
      const started = await startPair(resources, activeEpoch);
      monitorPair(started, resources, activeEpoch);
      return resources;
    } catch (error) {
      if (activeEpoch === epoch && !stopping) {
        markFailed(error instanceof Error ? error : new Error(String(error)));
      }
      throw error;
    }
  };

  return {
    async acquire() {
      if (stopping || stopPromise) {
        throw new Error("managed Linux desktop is stopping");
      }
      if (status.state === "failed") {
        throw new Error(status.error);
      }
      if (status.state === "running" && resources && pair && isPairCurrent(pair)) {
        return publicResult(resources);
      }
      if (monitorTasks.size > 0) {
        throw new Error("managed Linux desktop is restarting; retry when it is ready");
      }
      if (!startPromise) {
        stopping = false;
        restartTimes = [];
        audioRestartTimes = [];
        stderrTail = "";
        const activeEpoch = ++epoch;
        startPromise = start(activeEpoch).finally(() => {
          startPromise = undefined;
        });
      }
      return publicResult(await startPromise);
    },
    async acquireComputer(request) {
      const current = pair;
      if (status.state !== "running" || !resources || !current || !isPairCurrent(current)) {
        throw new Error("managed Linux desktop is unavailable for computer control");
      }
      const lease = { onStop: () => request.onStop() };
      current.computerLeases.add(lease);
      return {
        env: current.env,
        isCurrent: () => isPairCurrent(current) && current.computerLeases.has(lease),
        release: () => {
          current.computerLeases.delete(lease);
        },
      };
    },
    stop() {
      if (stopPromise) {
        return stopPromise;
      }
      stopping = true;
      ++epoch;
      const failed = status.state === "failed" ? status : undefined;
      const stopped = Promise.resolve().then(async () => {
        await stopPair(pair);
        await startPromise?.catch(() => undefined);
        await Promise.all(monitorTasks);
        await stopPair(pair);
        await removeResources();
        startPromise = undefined;
        restartTimes = [];
        audioRestartTimes = [];
        status = failed ?? { state: "not-started" };
        stopping = false;
      });
      stopPromise = stopped;
      void stopped
        .finally(() => {
          stopPromise = undefined;
        })
        .catch(() => undefined);
      return stopped;
    },
    status() {
      return { ...status };
    },
  };
}
