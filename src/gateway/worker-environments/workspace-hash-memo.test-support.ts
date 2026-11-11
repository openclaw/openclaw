import { beforeEach, onTestFinished, vi } from "vitest";
import * as runtimeWorker from "../../infra/runtime-worker-url.js";

const workerExecArgv = runtimeWorker.resolveRuntimeWorkerThreadExecArgv;

export function useAgedWorkspaceHashClock(): void {
  beforeEach(() => {
    // Keep real worker I/O while making fixture ctimes old enough for memo reuse.
    const clock = `data:text/javascript,Date.now=()=>${Date.now() + 60_000};`;
    const spy = vi
      .spyOn(runtimeWorker, "resolveRuntimeWorkerThreadExecArgv")
      .mockImplementation((...args) => [...workerExecArgv(...args), "--import", clock]);
    onTestFinished(() => spy.mockRestore());
  });
}
