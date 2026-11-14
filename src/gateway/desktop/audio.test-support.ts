import { vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import * as binaryDetection from "../../infra/detect-binary.js";
import type * as Supervisor from "../../process/supervisor/types.js";
import { runExit } from "./computer.test-support.js";
import { createManagedLinuxAudio, managedLinuxAudioEnv } from "./managed-linux-audio.js";

type ChildInput = Extract<Supervisor.SpawnInput, { mode: "child" }>;

export function createDesktopSupervisor(
  onSpawn: (input: ChildInput) => void | Promise<void>,
  cancelExit = runExit({ reason: "manual-cancel" }),
  onScopeCleaned: (scope: string) => void = () => {},
) {
  const inputs: ChildInput[] = [];
  const runs: Array<Supervisor.ManagedRun & { settle(exit: Supervisor.RunExit): void }> = [];
  const completions = new Map<number, ReturnType<typeof createDeferred<void>>>();
  const completion = (count: number) => {
    let pending = completions.get(count);
    if (!pending) {
      pending = createDeferred();
      completions.set(count, pending);
    }
    return pending;
  };
  const inScope = (scope: string) => runs.filter((_, index) => inputs[index]?.scopeKey === scope);
  const supervisor: Supervisor.ProcessSupervisor = {
    acquireScopeCleanup: (scope) => async () => {
      supervisor.cancelScope(scope);
      await Promise.all(inScope(scope).map((run) => run.wait()));
      onScopeCleaned(scope);
    },
    async spawn(input) {
      if (input.mode !== "child") {
        throw new Error("expected native child");
      }
      input.assertCurrent?.();
      const count = inputs.push(input);
      const result = createDeferred<Supervisor.RunExit>();
      const activity = { resultSettled: false, lastOutputAtMs: 0 };
      const run: (typeof runs)[number] = {
        runId: String(runs.length),
        startedAtMs: 0,
        activity,
        wait: () => result.promise,
        settle(exit: Supervisor.RunExit) {
          activity.resultSettled = true;
          result.resolve(exit);
        },
        cancel: () => run.settle(cancelExit),
      };
      runs.push(run);
      const admission = onSpawn(input);
      if (admission) {
        await admission;
      }
      // Notify after the caller resumes; native startup may also await filesystem work.
      const spawned = completion(count);
      setImmediate(() => spawned.resolve());
      return run;
    },
    cancel: (id) => runs.find((run) => run.runId === id)?.cancel(),
    cancelScope: (scope) => inScope(scope).forEach((run) => run.cancel()),
  };
  const exit = (index: number, stderr = "") => {
    const run = runs[index];
    if (!run || run.activity.resultSettled) {
      throw new Error(`fake run ${index} is unavailable`);
    }
    run.settle(runExit({ exitCode: 1, durationMs: 1, stderr }));
  };
  return {
    inputs,
    runs,
    supervisor,
    exit,
    afterSpawn: (count: number) => completion(count).promise,
    async restart(index: number, count: number) {
      exit(index);
      await completion(count).promise;
    },
  };
}

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
  const events = {
    serverSpawned: createDeferred(),
    captureSpawned: createDeferred(),
    captureAdmission: createDeferred(),
    captureSettled: createDeferred(),
    scopeCleaned: vi.fn(),
    captureAdmitted: vi.fn(),
  };
  const { inputs, runs, supervisor } = createDesktopSupervisor(
    async (input) => {
      if (input.argv[0] === "pulseaudio") {
        events.serverSpawned.resolve();
        if (!options.silentServer) {
          input.onStderr?.("I: main.c: Daemon startup complete.\n");
        }
      } else {
        events.captureSpawned.resolve();
        try {
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
        } finally {
          events.captureSettled.resolve();
        }
      }
    },
    undefined,
    events.scopeCleaned,
  );
  const env = { PULSE_SERVER: "unix:/unrelated/native", ...managedLinuxAudioEnv(tempDir) };
  vi.spyOn(binaryDetection, "detectBinary").mockImplementation(
    async (binary) => binary !== options.missing,
  );
  const owner = createManagedLinuxAudio({
    supervisor,
    tempDir,
    env,
    assertCurrent() {},
  });
  return { owner, inputs, runs, env, tempDir, ...events };
}
