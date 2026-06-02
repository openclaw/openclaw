import { formatErrorMessage } from "../infra/errors.js";
import { runCommandWithTimeout } from "../process/exec.js";

export type PluginCommandRunResult = {
  /** Process exit code, or 1 when the command could not be started or timed out without one. */
  code: number;
  /** Captured standard output, normalized to a string. */
  stdout: string;
  /** Captured standard error, or a synthesized failure message for thrown/timeout cases. */
  stderr: string;
};

export type PluginCommandRunOptions = {
  /** Command and arguments; an empty array returns a non-throwing failure result. */
  argv: string[];
  /** Wall-clock timeout passed to the shared process runner. */
  timeoutMs: number;
  /** Optional working directory for the child process. */
  cwd?: string;
  /** Optional environment override for the child process. */
  env?: NodeJS.ProcessEnv;
};

/** Run a plugin-managed command with timeout handling and normalized stdout/stderr results. */
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
    // Some process exits carry a timeout termination but no stderr; surface a stable message
    // so plugin CLIs can show actionable failure text without inspecting runner internals.
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
      stderr: formatErrorMessage(error),
    };
  }
}
