import { runCommandWithTimeout } from "../process/exec.js";

export type PluginCommandRunResult = {
  code: number;
  stdout: string;
  stderr: string;
};

export type PluginCommandRunOptions = {
  argv: string[];
  timeoutMs: number;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
};

export async function runPluginCommandWithTimeout(
  options: PluginCommandRunOptions,
): Promise<PluginCommandRunResult> {
  const [command] = options.argv;
  if (!command) {
    return { code: 1, stdout: "", stderr: "command is required" };
  }

  try {
    const result = await runCommandWithTimeout(options.argv, {
      timeoutMs: options.timeoutMs,
      cwd: options.cwd,
      env: options.env,
    });
    const timedOut = result.termination === "timeout" || result.termination === "no-output-timeout";
    return {
      code: result.code ?? 1,
      stdout: result.stdout,
      stderr: timedOut
        ? result.stderr || `command timed out after ${options.timeoutMs}ms`
        : result.stderr,
    };
  } catch (error) {
    return {
      code: 1,
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
    };
  }
}
