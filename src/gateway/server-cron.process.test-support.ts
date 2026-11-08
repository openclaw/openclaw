import { vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { RunExit } from "../process/supervisor/types.js";

export function runExit(overrides: Partial<RunExit> = {}): RunExit {
  return {
    reason: "manual-cancel",
    exitCode: null,
    exitSignal: null,
    durationMs: 1,
    stdout: "",
    stderr: "",
    timedOut: false,
    noOutputTimedOut: false,
    ...overrides,
  };
}

export function createWatchedRun(settleOnCancel = true, exitResult: Partial<RunExit> = {}) {
  const exit = createDeferred<RunExit>();
  return {
    exit,
    startedAtMs: Date.now(),
    cancel: vi.fn(() => {
      if (settleOnCancel) {
        exit.resolve(runExit(exitResult));
      }
    }),
    detachOutput: vi.fn(),
    wait: vi.fn(() => exit.promise),
  };
}
