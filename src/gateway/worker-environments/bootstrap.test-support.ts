import type { SpawnResult } from "../../process/exec.js";
import type { WorkerBootstrapCommandRunner } from "./bootstrap-command.js";

export function result(overrides: Partial<SpawnResult> = {}): SpawnResult {
  return {
    stdout: "",
    stderr: "",
    code: 0,
    signal: null,
    killed: false,
    termination: "exit",
    ...overrides,
  };
}

export function fakeRunner(
  responses: SpawnResult[],
  inspectCall?: (
    argv: string[],
    options: Parameters<WorkerBootstrapCommandRunner>[1],
  ) => void | Promise<void>,
) {
  const calls: Array<{
    argv: string[];
    options: Parameters<WorkerBootstrapCommandRunner>[1];
  }> = [];
  const runCommand: WorkerBootstrapCommandRunner = async (argv, options) => {
    calls.push({ argv, options });
    await inspectCall?.(argv, options);
    const response = responses.shift();
    if (!response) {
      throw new Error("unexpected bootstrap command");
    }
    return response;
  };
  return { calls, runCommand };
}
