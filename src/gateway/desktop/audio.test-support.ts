import { vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type * as Supervisor from "../../process/supervisor/types.js";
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
    beforeCaptureReturn?: () => void;
  } = {},
) {
  const inputs: Array<Extract<Supervisor.SpawnInput, { mode: "child" }>> = [];
  const runs: Supervisor.ManagedRun[] = [];
  const events = {
    serverSpawned: createDeferred(),
    captureSpawned: createDeferred(),
    captureAdmission: createDeferred(),
    scopeCleaned: vi.fn(),
    captureAdmitted: vi.fn(),
  };
  const inScope = (scope: string) => runs.filter((_, index) => inputs[index]?.scopeKey === scope);
  const supervisor: Supervisor.ProcessSupervisor = {
    acquireScopeCleanup: (scope) => async () => {
      supervisor.cancelScope(scope);
      await Promise.all(inScope(scope).map((run) => run.wait()));
      events.scopeCleaned(scope);
    },
    async spawn(input) {
      if (input.mode !== "child") {
        throw new Error("expected native child");
      }
      input.assertCurrent?.();
      inputs.push(input);
      const exit = createDeferred<Supervisor.RunExit>();
      const activity = { resultSettled: false, lastOutputAtMs: 0 };
      const run: Supervisor.ManagedRun = {
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
        events.serverSpawned.resolve();
        if (!options.silentServer) {
          input.onStderr?.("I: main.c: Daemon startup complete.\n");
        }
      } else {
        events.captureSpawned.resolve();
        if (options.deferCapture) {
          await events.captureAdmission.promise;
          input.assertCurrent?.();
        }
        events.captureAdmitted();
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
    cancel: (id) => runs.find((run) => run.runId === id)?.cancel(),
    cancelScope: (scope) => inScope(scope).forEach((run) => run.cancel()),
  };
  const env = { PULSE_SERVER: "unix:/unrelated/native", ...managedLinuxAudioEnv(tempDir) };
  const owner = createManagedLinuxAudio({
    supervisor,
    tempDir,
    env,
    assertCurrent() {},
    runtime: {
      detectBinary: async (binary) => binary !== options.missing,
      startupTimeoutMs: 100,
    },
  });
  return { owner, inputs, runs, env, tempDir, ...events };
}
