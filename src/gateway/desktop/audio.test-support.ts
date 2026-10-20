import { vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type {
  ManagedRun,
  ProcessSupervisor,
  RunExit,
  SpawnInput,
} from "../../process/supervisor/types.js";
import { runExit } from "./computer.test-support.js";
import { createManagedLinuxAudio, managedLinuxAudioEnv } from "./managed-linux-audio.js";

export function assertAudioCurrent(current: boolean) {
  if (!current) {
    throw new Error("viewer retired");
  }
}

export function createAudioFixture(
  tempDir: string,
  options: {
    missing?: string;
    silentServer?: boolean;
    silentCapture?: boolean;
    captureFailure?: boolean;
    deferCapture?: boolean;
    startupTimeoutMs?: number;
    beforeCaptureReturn?: () => void;
  } = {},
) {
  const inputs: Array<Extract<SpawnInput, { mode: "child" }>> = [];
  const runs: ManagedRun[] = [];
  const serverSpawned = createDeferred();
  const captureSpawned = createDeferred();
  const captureAdmission = createDeferred();
  const captureSettled = createDeferred();
  const scopeCleaned = vi.fn();
  const captureAdmitted = vi.fn();
  const nativeGuard = vi.fn();
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
      const activity = { resultSettled: false, lastOutputAtMs: 0 };
      const run: ManagedRun = {
        runId: String(runs.length),
        startedAtMs: 0,
        activity,
        wait: () => exit.promise,
        cancel() {
          activity.resultSettled = true;
          exit.resolve(runExit({ reason: "manual-cancel" }));
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
        try {
          if (options.deferCapture) {
            await captureAdmission.promise;
            nativeGuard(() => input.assertCurrent?.());
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
        } finally {
          captureSettled.resolve();
        }
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
    runtime: {
      detectBinary: async (binary) => binary !== options.missing,
      startupTimeoutMs: options.startupTimeoutMs ?? 100,
    },
  });
  return {
    owner,
    inputs,
    runs,
    env,
    tempDir,
    serverSpawned,
    captureSpawned,
    captureAdmission,
    captureSettled,
    scopeCleaned,
    captureAdmitted,
    nativeGuard,
  };
}
