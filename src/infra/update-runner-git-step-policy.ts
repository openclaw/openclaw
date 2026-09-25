import type { CommandRunner, RunStepOptions, UpdateRunnerOptions } from "./update-runner-types.js";
import type { UpdateStepResult } from "./update-step-result.js";

/** Work and probes share progress ordering, including commands in the private inspection clone. */
export function createGitUpdateSteps(params: {
  runCommand: CommandRunner;
  opts: Pick<UpdateRunnerOptions, "timeoutMs" | "progress">;
  probeTimeoutMs: number;
  totalSteps: number;
  results: UpdateStepResult[];
}) {
  let stepIndex = 0;
  const forRunner = (runCommand: CommandRunner) => {
    const withDeadline =
      (timeoutMs: number | undefined) =>
      (name: string, argv: string[], cwd: string, env?: NodeJS.ProcessEnv): RunStepOptions => ({
        runCommand,
        name,
        argv,
        cwd,
        timeoutMs,
        env,
        progress: params.opts.progress,
        stepIndex: stepIndex++,
        totalSteps: params.totalSteps,
        results: params.results,
      });
    return {
      step: withDeadline(params.probeTimeoutMs),
      // Work can outlive an observation allowance. Only the caller may cap it.
      workStep: withDeadline(params.opts.timeoutMs),
    };
  };
  const recoveryStep = (name: string, argv: string[], cwd: string): RunStepOptions => ({
    runCommand: params.runCommand,
    name,
    argv,
    cwd,
    // Recovery retains its finite settlement allowance after work has failed.
    timeoutMs: params.probeTimeoutMs,
    stepIndex: 0,
    totalSteps: 1,
    results: params.results,
  });
  return { ...forRunner(params.runCommand), forRunner, recoveryStep };
}
