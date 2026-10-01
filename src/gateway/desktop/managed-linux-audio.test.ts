import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type {
  ManagedRun,
  ProcessSupervisor,
  RunExit,
  SpawnInput,
} from "../../process/supervisor/types.js";
import { createManagedLinuxAudio, managedLinuxAudioEnv } from "./managed-linux-audio.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  vi.useRealTimers();
});

function fixture(
  options: {
    missing?: string;
    silentServer?: boolean;
    silentCapture?: boolean;
    captureFailure?: boolean;
    deferCapture?: boolean;
    beforeCaptureReturn?: () => void;
  } = {},
) {
  const tempDir = tempDirs.make("desktop-audio-test-");
  const inputs: Array<Extract<SpawnInput, { mode: "child" }>> = [];
  const runs: ManagedRun[] = [];
  const serverSpawned = createDeferred();
  const captureSpawned = createDeferred();
  const captureAdmission = createDeferred();
  const scopeCleaned = vi.fn();
  const captureAdmitted = vi.fn();
  const supervisor: ProcessSupervisor = {
    acquireScopeCleanup(scope) {
      return async () => {
        supervisor.cancelScope(scope);
        await Promise.all(
          runs.filter((_, index) => inputs[index]?.scopeKey === scope).map((run) => run.wait()),
        );
        scopeCleaned(scope);
      };
    },
    async spawn(input) {
      if (input.mode !== "child") {
        throw new Error("expected native child");
      }
      input.assertCurrent?.();
      inputs.push(input);
      const exit = createDeferred<RunExit>();
      let settled = false;
      const run: ManagedRun = {
        runId: String(runs.length),
        startedAtMs: 0,
        activity: {
          get resultSettled() {
            return settled;
          },
          lastOutputAtMs: 0,
        },
        wait: () => exit.promise,
        cancel() {
          settled = true;
          exit.resolve({
            reason: "manual-cancel",
            exitCode: 0,
            exitSignal: null,
            durationMs: 0,
            stdout: "",
            stderr: "",
            timedOut: false,
            noOutputTimedOut: false,
          });
        },
      };
      runs.push(run);
      if (input.argv[0] === "pulseaudio") {
        serverSpawned.resolve();
        if (!options.silentServer) {
          input.onStderr?.("I: main.c: Daemon startup complete.\n");
        }
      } else {
        captureSpawned.resolve();
        if (options.deferCapture) {
          await captureAdmission.promise;
          input.assertCurrent?.();
        }
        captureAdmitted();
        if (options.captureFailure) {
          throw new Error("parec spawn failed");
        }
        if (!options.silentCapture) {
          input.onStdoutRaw?.(Buffer.from([0, 128, 255, 127]));
        }
        options.beforeCaptureReturn?.();
      }
      return run;
    },
    cancel(id) {
      runs.find((run) => run.runId === id)?.cancel();
    },
    cancelScope(scope) {
      for (const [index, run] of runs.entries()) {
        if (inputs[index]?.scopeKey === scope) {
          run.cancel();
        }
      }
    },
  };
  const env = { PULSE_SERVER: "unix:/unrelated/native", ...managedLinuxAudioEnv(tempDir) };
  const owner = createManagedLinuxAudio({
    supervisor,
    tempDir,
    env,
    assertCurrent() {},
    runtime: { detectBinary: async (binary) => binary !== options.missing, startupTimeoutMs: 100 },
  });
  cleanups.push(() => owner.stop());
  return {
    owner,
    inputs,
    runs,
    env,
    tempDir,
    serverSpawned,
    captureSpawned,
    captureAdmission,
    scopeCleaned,
    captureAdmitted,
  };
}

describe("managed Linux private audio", () => {
  it("loads only a private null sink and does not record before explicit start", async () => {
    const f = fixture();
    const audio = await f.owner.ready;
    expect(audio.source).toBeDefined();
    expect(f.inputs).toHaveLength(1);
    expect(f.inputs[0]?.argv).toContain("-n");
    expect(f.inputs[0]?.env?.PULSE_RUNTIME_PATH).toBe(path.join(f.tempDir, "pulse"));
    const script = await fs.readFile(path.join(f.tempDir, "pulse", "default.pa"), "utf8");
    expect(script.match(/load-module /gu)).toHaveLength(2);
    expect(script).toContain("module-null-sink sink_name=openclaw_desktop");
    expect(script).not.toMatch(/udev|alsa|tcp|default.pa/u);
    expect(await fs.readFile(path.join(f.tempDir, "pulse", "client.conf"), "utf8")).toBe(
      "autospawn = no\n",
    );
    const capture = await audio.source!.start(new AbortController().signal);
    expect(f.inputs[1]?.argv).toEqual([
      "parec",
      "--server=" + f.env.PULSE_SERVER,
      "--device=openclaw_desktop.monitor",
      "--raw",
      "--format=s16le",
      "--rate=48000",
      "--channels=2",
      "--channel-map=front-left,front-right",
      "--latency-msec=40",
    ]);
    expect(f.inputs[1]?.captureOutput).toBe(false);
    expect(capture.stream.read()).toEqual(Buffer.from([0, 128, 255, 127]));
    await capture.stop();
    expect(f.runs[1]?.activity.resultSettled).toBe(true);
    expect(f.runs[0]?.activity.resultSettled).toBe(false);
  });

  it.each(["pulseaudio", "parec"])(
    "advertises absent %s without starting a server",
    async (missing) => {
      const f = fixture({ missing });
      const audio = await f.owner.ready;
      expect(audio.source).toBeUndefined();
      expect(audio.failed).toBeUndefined();
      expect(audio.unavailableReason).toContain(missing + " is not installed");
      expect(f.inputs).toHaveLength(0);
      expect(f.scopeCleaned).toHaveBeenCalledOnce();
    },
  );

  it("bounds server readiness and reaps failed startup", async () => {
    vi.useFakeTimers();
    const f = fixture({ silentServer: true });
    await f.serverSpawned.promise;
    await vi.advanceTimersByTimeAsync(101);
    expect((await f.owner.ready).unavailableReason).toContain("startup timed out");
    expect(f.runs.every((run) => run.activity.resultSettled)).toBe(true);
  });

  it("bounds capture readiness without stopping the desktop server", async () => {
    const f = fixture({ silentCapture: true });
    const audio = await f.owner.ready;
    vi.useFakeTimers();
    const started = audio.source!.start(new AbortController().signal);
    const rejected = expect(started).rejects.toThrow("capture startup timed out");
    await f.captureSpawned.promise;
    await vi.advanceTimersByTimeAsync(101);
    await rejected;
    expect(f.runs[1]?.activity.resultSettled).toBe(true);
    expect(f.runs[0]?.activity.resultSettled).toBe(false);
  });

  it("joins abort cleanup during pending native admission", async () => {
    const f = fixture({ deferCapture: true });
    const audio = await f.owner.ready;
    const controller = new AbortController();
    const started = audio.source!.start(controller.signal);
    const rejected = expect(started).rejects.toThrow("aborted");
    await f.captureSpawned.promise;
    controller.abort();
    f.captureAdmission.resolve();
    await rejected;
    expect(f.runs[1]?.activity.resultSettled).toBe(true);
  });

  it.each([true, false])(
    "revalidates live authority at native admission without an abort (%s)",
    async (allowed) => {
      const f = fixture({ deferCapture: true });
      const audio = await f.owner.ready;
      let current = true;
      const controller = new AbortController();
      const started = audio.source!.start(controller.signal, () => {
        if (!current) {
          throw new Error("viewer retired");
        }
      });
      const rejected = allowed ? undefined : expect(started).rejects.toThrow("viewer retired");
      await f.captureSpawned.promise;
      current = allowed;
      f.captureAdmission.resolve();
      if (allowed) {
        const capture = await started;
        expect(capture.stream.read()).toEqual(Buffer.from([0, 128, 255, 127]));
        await capture.stop();
      } else {
        await rejected;
      }
      expect(controller.signal.aborted).toBe(false);
      expect(f.captureAdmitted).toHaveBeenCalledTimes(allowed ? 1 : 0);
      expect(f.runs[1]?.activity.resultSettled).toBe(true);
      expect(f.runs[0]?.activity.resultSettled).toBe(false);
    },
  );

  it("rechecks live authority after native startup settles and joins cleanup", async () => {
    let current = true;
    const f = fixture({
      beforeCaptureReturn: () => {
        current = false;
      },
    });
    const audio = await f.owner.ready;
    await expect(
      audio.source!.start(new AbortController().signal, () => {
        if (!current) {
          throw new Error("viewer retired");
        }
      }),
    ).rejects.toThrow("viewer retired");
    expect(f.captureAdmitted).toHaveBeenCalledOnce();
    expect(f.runs[1]?.activity.resultSettled).toBe(true);
    expect(f.runs[0]?.activity.resultSettled).toBe(false);
  });

  it("reaps capture startup errors and rejects pre-aborted requests", async () => {
    const f = fixture({ captureFailure: true });
    const audio = await f.owner.ready;
    await expect(audio.source!.start(AbortSignal.abort())).rejects.toThrow();
    expect(f.inputs).toHaveLength(1);
    await expect(audio.source!.start(new AbortController().signal)).rejects.toThrow(
      "parec spawn failed",
    );
    expect(f.runs[1]?.activity.resultSettled).toBe(true);
  });

  it("bounds unread PCM and terminates a stalled viewer", async () => {
    const f = fixture();
    const audio = await f.owner.ready;
    const capture = await audio.source!.start(new AbortController().signal);
    f.inputs[1]?.onStdoutRaw?.(Buffer.alloc(192_000));
    expect(capture.stream.destroyed).toBe(true);
    expect(capture.stream.errored?.message).toContain("not consuming");
    await capture.stop();
    expect(f.runs[1]?.activity.resultSettled).toBe(true);
  });

  it("server loss retires sources and closes all active captures", async () => {
    const f = fixture();
    const audio = await f.owner.ready;
    const source = audio.source!;
    const capture = await source.start(new AbortController().signal);
    f.runs[0]?.cancel();
    await audio.failed;
    expect(audio.source).toBeUndefined();
    await f.owner.stop();
    expect(capture.stream.destroyed).toBe(true);
    expect(audio.source).toBeUndefined();
    expect(audio.unavailableReason).toBeDefined();
    expect(f.runs.every((run) => run.activity.resultSettled)).toBe(true);
    await expect(source.start(new AbortController().signal)).rejects.toThrow("unavailable");
  });
});
