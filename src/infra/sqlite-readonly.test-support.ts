import { promisify } from "node:util";
import { vi } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";

export function mockChildProcesses(
  actual: typeof import("node:child_process"),
  execFile = vi.fn(actual.execFile),
) {
  execFile.mockImplementation(actual.execFile);
  Object.defineProperty(
    execFile,
    promisify.custom,
    Object.getOwnPropertyDescriptor(actual.execFile, promisify.custom)!,
  );
  return { ...actual, execFile, spawn: vi.fn(actual.spawn), spawnSync: vi.fn(actual.spawnSync) };
}

export function createReadBarrier() {
  const entered = createDeferredCore();
  const resume = createDeferredCore();
  const hold = async <T>(value: T): Promise<T> => {
    entered.resolve();
    await resume.promise;
    return value;
  };
  return {
    entered,
    resume,
    hold,
    pause: async <T>(value: T | PromiseLike<T>): Promise<T> => hold(await value),
  };
}

export function observeSettlement(promise: Promise<unknown>) {
  const observation = { settled: false };
  const mark = () => {
    observation.settled = true;
  };
  void promise.then(mark, mark);
  return observation;
}
