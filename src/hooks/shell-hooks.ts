/**
 * Shell command hook execution for Claude Code-style hooks.
 *
 * Provides the ability to execute shell commands as hook handlers,
 * passing JSON input via stdin and capturing stdout/exit codes.
 *
 * Exit codes:
 * - 0: Success, stdout is captured as output
 * - 2: Deny - the hook denies the action (e.g., block a tool use)
 * - Other non-zero: Error, logged but doesn't deny
 */

import { spawn } from "node:child_process";

/**
 * Result of executing a shell hook command.
 */
export type ShellHookResult = {
  /** Stdout output from the command */
  stdout: string;
  /** Stderr output from the command */
  stderr: string;
  /** Exit code (0 = success, 2 = deny, other = error) */
  exitCode: number;
  /** Whether the hook execution was successful (exit 0) */
  success: boolean;
  /** Whether the hook denied the action (exit 2) */
  denied: boolean;
  /** Error message if execution failed */
  error?: string;
};

/**
 * Options for shell hook execution.
 */
export type ShellHookOptions = {
  /** Working directory for the command */
  cwd?: string;
  /** Timeout in milliseconds (default: 30000) */
  timeoutMs?: number;
  /** Additional environment variables */
  env?: Record<string, string>;
};

const DEFAULT_TIMEOUT_MS = 30000;

/**
 * Execute a shell hook command.
 *
 * The command is executed with a shell, and JSON input is piped to stdin.
 * The command's stdout is captured and returned.
 *
 * @param command - Shell command to execute
 * @param input - Input object to pass as JSON via stdin
 * @param options - Execution options
 * @returns ShellHookResult with stdout, exit code, and status
 *
 * @example
 * ```ts
 * const result = await executeShellHook(
 *   'cat ~/.claude/SOUL.md',
 *   { prompt: 'hello', sessionId: 'abc123' },
 *   { cwd: '/path/to/workspace' }
 * );
 *
 * if (result.denied) {
 *   console.log('Hook denied the action:', result.stdout);
 * } else if (result.success) {
 *   console.log('Hook output:', result.stdout);
 * }
 * ```
 */
export async function executeShellHook(
  command: string,
  input: Record<string, unknown>,
  options: ShellHookOptions = {},
): Promise<ShellHookResult> {
  const { cwd, timeoutMs = DEFAULT_TIMEOUT_MS, env } = options;

  return new Promise((resolve) => {
    const startTime = Date.now();

    // Spawn shell to execute the command
    const child = spawn(command, {
      shell: true,
      cwd,
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let resolved = false;

    const resolveOnce = (result: ShellHookResult) => {
      if (!resolved) {
        resolved = true;
        resolve(result);
      }
    };

    // Set up timeout
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      resolveOnce({
        stdout,
        stderr,
        exitCode: -1,
        success: false,
        denied: false,
        error: `Command timed out after ${timeoutMs}ms`,
      });
    }, timeoutMs);

    // Collect stdout
    child.stdout.on("data", (data: Buffer) => {
      stdout += data.toString();
    });

    // Collect stderr
    child.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    // Handle process exit
    child.on("close", (code) => {
      clearTimeout(timeout);
      const exitCode = code ?? 1;
      const durationMs = Date.now() - startTime;

      // Log execution for debugging (only in verbose mode)
      if (process.env.OPENCLAW_VERBOSE === "1") {
        console.log(`[shell-hook] ${command} exited with code ${exitCode} in ${durationMs}ms`);
      }

      resolveOnce({
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        exitCode,
        success: exitCode === 0,
        denied: exitCode === 2,
        error: exitCode !== 0 && exitCode !== 2 ? `Exit code: ${exitCode}` : undefined,
      });
    });

    // Handle spawn errors
    child.on("error", (err) => {
      clearTimeout(timeout);
      resolveOnce({
        stdout,
        stderr,
        exitCode: -1,
        success: false,
        denied: false,
        error: `Spawn error: ${err.message}`,
      });
    });

    // Write JSON input to stdin
    try {
      const jsonInput = JSON.stringify(input);
      child.stdin.write(jsonInput);
      child.stdin.end();
    } catch (err) {
      // If stdin write fails, continue - command may not need stdin
      child.stdin.end();
    }
  });
}

/**
 * Execute multiple shell hooks in sequence.
 * Stops on first deny (exit code 2).
 *
 * @param commands - Array of shell commands to execute
 * @param input - Input object to pass to each command
 * @param options - Execution options
 * @returns Combined result with all outputs
 */
export async function executeShellHooksSequential(
  commands: string[],
  input: Record<string, unknown>,
  options: ShellHookOptions = {},
): Promise<{
  outputs: string[];
  denied: boolean;
  denyReason?: string;
  errors: string[];
}> {
  const result = {
    outputs: [] as string[],
    denied: false,
    denyReason: undefined as string | undefined,
    errors: [] as string[],
  };

  for (const command of commands) {
    const hookResult = await executeShellHook(command, input, options);

    if (hookResult.stdout) {
      result.outputs.push(hookResult.stdout);
    }

    if (hookResult.denied) {
      result.denied = true;
      result.denyReason = hookResult.stdout || "Hook denied the action";
      break; // Stop processing on deny
    }

    if (hookResult.error) {
      result.errors.push(`${command}: ${hookResult.error}`);
    }
  }

  return result;
}
