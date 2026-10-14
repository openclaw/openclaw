import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { detectBinary } from "../../infra/detect-binary.js";
import type { ManagedRun, ProcessSupervisor } from "../../process/supervisor/types.js";
import { createDeferredCore } from "../../shared/deferred.js";

const SINK_NAME = "openclaw_desktop";
const STARTUP_TIMEOUT_MS = 5_000;
// A stalled viewer must not accumulate an unbounded live recording (one second of PCM).
const MAX_BUFFER_BYTES = 48_000 * 2 * 2;
const AUDIO_GUIDANCE = "Install pulseaudio and pulseaudio-utils for managed desktop audio.";

/** Raw interleaved PCM s16le, 48000 Hz, stereo. No microphone or host mix. */
export type DesktopAudioSource = {
  start(
    signal: AbortSignal,
    assertAuthority?: () => void,
  ): Promise<{ stream: Readable; stop(): Promise<void> }>;
};

export type ManagedLinuxAudio = {
  source?: DesktopAudioSource;
  unavailableReason?: string;
  /** Published only after successful startup; the desktop owner handles recovery. */
  failed?: Promise<void>;
  stop(): Promise<void>;
};

/** Private server/capture routing; apply to apps only after the server is ready. */
export function managedLinuxAudioEnv(tempDir: string): NodeJS.ProcessEnv {
  const runtimeDir = path.join(tempDir, "pulse");
  return {
    PULSE_SERVER: `unix:${path.join(runtimeDir, "native")}`,
    PULSE_SINK: SINK_NAME,
    PULSE_SOURCE: `${SINK_NAME}.monitor`,
    PULSE_RUNTIME_PATH: runtimeDir,
    PULSE_STATE_PATH: path.join(runtimeDir, "state"),
    PULSE_CLIENTCONFIG: path.join(runtimeDir, "client.conf"),
  };
}

/** One server per desktop generation; capture processes exist only after source.start(). */
export function createManagedLinuxAudio(params: {
  supervisor: ProcessSupervisor;
  tempDir: string;
  env: NodeJS.ProcessEnv;
  assertCurrent(): void;
  runtime?: { detectBinary?: typeof detectBinary; startupTimeoutMs?: number };
}): { ready: Promise<ManagedLinuxAudio>; stop(): Promise<void> } {
  const { supervisor } = params;
  const env = { ...params.env, ...managedLinuxAudioEnv(params.tempDir) };
  const daemonEnv: NodeJS.ProcessEnv = {
    ...env,
    LC_ALL: "C",
    PULSE_CONFIG: path.join(params.tempDir, "pulse", "daemon.conf"),
  };
  delete daemonEnv.PULSE_SCRIPT;
  delete daemonEnv.PULSE_DLPATH;
  delete daemonEnv.NOTIFY_SOCKET;
  delete daemonEnv.PULSE_COOKIE;
  delete daemonEnv.PULSE_LOG;
  delete daemonEnv.PULSE_LOG_TARGET;
  const scopeKey = `managed-desktop-audio:${crypto.randomUUID()}`;
  const cleanup = supervisor.acquireScopeCleanup(scopeKey, { processTree: "required-all" });
  const ready = createDeferredCore<ManagedLinuxAudio>();
  const serverReady = createDeferredCore();
  const daemonFailed = createDeferredCore();
  const captures = new Set<() => Promise<void>>();
  const startupTimeoutMs = params.runtime?.startupTimeoutMs ?? STARTUP_TIMEOUT_MS;
  let active = true;
  let closing: Promise<void> | undefined;
  let stderr = "";
  const result: ManagedLinuxAudio = { stop: () => stop() };
  const assertActive = () => {
    params.assertCurrent();
    if (!active) {
      throw new Error(result.unavailableReason ?? "Managed desktop audio is stopped");
    }
  };
  const stop = (): Promise<void> => {
    if (closing) {
      return closing;
    }
    active = false;
    delete result.source;
    serverReady.reject(new Error("Managed desktop audio stopped during startup"));
    const captureCleanup = Promise.allSettled([...captures].map((close) => close()));
    supervisor.cancelScope(scopeKey, "manual-cancel");
    closing = Promise.resolve().then(async () => {
      await launch;
      const outcomes = await captureCleanup;
      await cleanup();
      const failed = outcomes.find((outcome) => outcome.status === "rejected");
      if (failed) {
        throw failed.reason;
      }
    });
    return closing;
  };
  const unavailable = (error: unknown) => {
    const detail = error instanceof Error ? error.message : String(error);
    result.unavailableReason ??= `Managed desktop audio unavailable: ${detail}. ${AUDIO_GUIDANCE}`;
    void stop().catch(() => {});
    daemonFailed.resolve();
  };
  // Install a handler before any synchronous fake or native process output arrives.
  void serverReady.promise.catch(() => {});
  const timer = setTimeout(() => {
    unavailable(new Error("private PulseAudio startup timed out"));
  }, startupTimeoutMs);
  timer.unref?.();

  const source: DesktopAudioSource = {
    async start(signal, assertAuthority) {
      const assertCaptureCurrent = () => {
        assertActive();
        signal.throwIfAborted();
        assertAuthority?.();
      };
      assertCaptureCurrent();
      const captureScope = `${scopeKey}:capture:${crypto.randomUUID()}`;
      const cleanupCapture = supervisor.acquireScopeCleanup(captureScope, {
        processTree: "required-all",
      });
      const firstData = createDeferredCore();
      let running = true;
      let stopped: Promise<void> | undefined;
      let captureStderr = "";
      let captureRun: ManagedRun | undefined;
      const stream = new Readable({ read() {}, highWaterMark: MAX_BUFFER_BYTES });
      // The first failure may race the caller installing its error listener.
      stream.on("error", () => {});
      const stopCapture = (): Promise<void> => {
        if (stopped) {
          return stopped;
        }
        running = false;
        clearTimeout(captureTimer);
        signal.removeEventListener("abort", abort);
        firstData.reject(new Error("Desktop audio capture stopped"));
        stream.destroy();
        captureRun?.detachOutput?.();
        supervisor.cancelScope(captureScope, "manual-cancel");
        stopped = Promise.resolve().then(async () => {
          await captureLaunch;
          await cleanupCapture();
          captures.delete(stopCapture);
        });
        return stopped;
      };
      const failCapture = (error: Error) => {
        if (!running) {
          return;
        }
        firstData.reject(error);
        stream.destroy(error);
        void stopCapture().catch(() => {});
      };
      const abort = () => failCapture(new Error("Desktop audio capture aborted"));
      const captureTimer = setTimeout(
        () => failCapture(new Error("Desktop audio capture startup timed out")),
        startupTimeoutMs,
      );
      captureTimer.unref?.();
      captures.add(stopCapture);
      signal.addEventListener("abort", abort, { once: true });
      stream.once("close", () => void stopCapture().catch(() => {}));
      const captureLaunch = Promise.resolve().then(async () => {
        try {
          captureRun = await supervisor.spawn({
            scopeKey: captureScope,
            mode: "child",
            argv: [
              "parec",
              `--server=${env.PULSE_SERVER}`,
              `--device=${SINK_NAME}.monitor`,
              "--raw",
              "--format=s16le",
              "--rate=48000",
              "--channels=2",
              "--channel-map=front-left,front-right",
              "--latency-msec=40",
            ],
            env,
            exactEnv: true,
            stdinMode: "pipe-closed",
            captureOutput: false,
            assertCurrent: () => {
              assertCaptureCurrent();
              if (!running) {
                throw new Error("Desktop audio capture stopped");
              }
            },
            onStderr: (chunk) => {
              captureStderr = (captureStderr + chunk).slice(-4096);
            },
            onStdoutRaw: (chunk) => {
              if (!running || chunk.length === 0) {
                return;
              }
              if (stream.readableLength + chunk.length > MAX_BUFFER_BYTES) {
                failCapture(new Error("Desktop audio viewer is not consuming audio"));
                return;
              }
              stream.push(chunk);
              firstData.resolve();
            },
          });
          void captureRun.wait().then(
            () => failCapture(new Error(captureStderr.trim() || "Desktop audio capture exited")),
            (error: unknown) =>
              failCapture(error instanceof Error ? error : new Error(String(error))),
          );
        } catch (error) {
          failCapture(error instanceof Error ? error : new Error(String(error)));
        }
      });
      try {
        await firstData.promise;
        await captureLaunch;
        assertCaptureCurrent();
        if (!running) {
          throw new Error("Desktop audio capture stopped during startup");
        }
        return { stream, stop: stopCapture };
      } catch (error) {
        await stopCapture();
        throw error;
      } finally {
        clearTimeout(captureTimer);
      }
    },
  };

  const launch = Promise.resolve().then(async () => {
    try {
      const detect = params.runtime?.detectBinary ?? detectBinary;
      for (const binary of ["pulseaudio", "parec"]) {
        if (!(await detect(binary))) {
          throw new Error(`${binary} is not installed`);
        }
        assertActive();
      }
      const runtimeDir = path.join(params.tempDir, "pulse");
      await fs.mkdir(runtimeDir, { recursive: true, mode: 0o700 });
      // Client/server startup files are external-tool contracts, not OpenClaw state.
      await fs.writeFile(path.join(runtimeDir, "client.conf"), "autospawn = no\n", { mode: 0o600 });
      await fs.writeFile(path.join(runtimeDir, "daemon.conf"), "local-server-type = user\n", {
        mode: 0o600,
      });
      const script = path.join(runtimeDir, "default.pa");
      await fs.writeFile(
        script,
        [
          ".fail",
          `load-module module-null-sink sink_name=${SINK_NAME} format=s16le rate=48000 channels=2 channel_map=front-left,front-right`,
          `set-default-sink ${SINK_NAME}`,
          `set-default-source ${SINK_NAME}.monitor`,
          // Socket is under the desktop's mode-0700 directory. No TCP or hardware modules.
          "load-module module-native-protocol-unix auth-anonymous=1 auth-cookie-enabled=0",
          "",
        ].join("\n"),
        { mode: 0o600 },
      );
      assertActive();
      const run = await supervisor.spawn({
        scopeKey,
        mode: "child",
        argv: [
          "pulseaudio",
          "--daemonize=no",
          "--fail=yes",
          "--use-pid-file=no",
          "--exit-idle-time=-1",
          "--disable-shm=yes",
          "--system=no",
          "--realtime=no",
          "--high-priority=no",
          "--disallow-exit=yes",
          "--disallow-module-loading=yes",
          "--log-target=stderr",
          "--log-level=info",
          "-n",
          "--file",
          script,
        ],
        env: daemonEnv,
        exactEnv: true,
        assertCurrent: assertActive,
        stdinMode: "pipe-closed",
        captureOutput: false,
        onStderr: (chunk) => {
          stderr = (stderr + chunk).slice(-4096);
          if (stderr.includes("Daemon startup complete.")) {
            serverReady.resolve();
          }
        },
      });
      void run
        .wait()
        .then(
          () => unavailable(new Error(stderr.trim() || "private PulseAudio exited")),
          unavailable,
        );
      await serverReady.promise;
      assertActive();
      result.source = source;
      result.failed = daemonFailed.promise;
    } catch (error) {
      unavailable(error);
    } finally {
      clearTimeout(timer);
      ready.resolve(result);
    }
  });
  return {
    // Failed optional startup joins native cleanup before screen startup continues.
    ready: ready.promise.then(async (value) => {
      if (closing) {
        await closing;
      }
      return value;
    }),
    stop,
  };
}
