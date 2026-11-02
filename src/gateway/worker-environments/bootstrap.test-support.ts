import type { SpawnResult } from "../../process/exec.js";
import type { WorkerBootstrapCommandRunner } from "./bootstrap-command.js";

export { createCommandResult as result } from "../../test-utils/npm-spec-install-test-helpers.js";

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
