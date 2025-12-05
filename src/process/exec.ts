import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

import { danger, isVerbose } from "../globals.js";
import { logDebug, logError } from "../logger.js";

const execFileAsync = promisify(execFile);

// Simple promise-wrapped execFile with optional verbosity logging.
export async function runExec(
  command: string,
  args: string[],
  opts: number | { timeoutMs?: number; maxBuffer?: number } = 10_000,
): Promise<{ stdout: string; stderr: string }> {
  const options =
    typeof opts === "number"
      ? { timeout: opts, encoding: "utf8" as const }
      : {
          timeout: opts.timeoutMs,
          maxBuffer: opts.maxBuffer,
          encoding: "utf8" as const,
        };
  try {
    const { stdout, stderr } = await execFileAsync(command, args, options);
    if (isVerbose()) {
      if (stdout.trim()) logDebug(stdout.trim());
      if (stderr.trim()) logError(stderr.trim());
    }
    return { stdout, stderr };
  } catch (err) {
    if (isVerbose()) {
      logError(danger(`Command failed: ${command} ${args.join(" ")}`));
    }
    throw err;
  }
}

export type SpawnResult = {
  stdout: string;
  stderr: string;
  code: number | null;
  signal: NodeJS.Signals | null;
  killed: boolean;
};

export type CommandOptions = {
  timeoutMs: number;
  cwd?: string;
  input?: string;
};

export async function runCommandWithTimeout(
  argv: string[],
  optionsOrTimeout: number | CommandOptions,
): Promise<SpawnResult> {
  const options: CommandOptions =
    typeof optionsOrTimeout === "number"
      ? { timeoutMs: optionsOrTimeout }
      : optionsOrTimeout;
  const { timeoutMs, cwd, input } = options;

  // Spawn with inherited stdin (TTY) so tools like `claude` don't hang.
  return await new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), {
      stdio: [input ? "pipe" : "inherit", "pipe", "pipe"],
      cwd,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, timeoutMs);

    if (input && child.stdin) {
      child.stdin.write(input);
      child.stdin.end();
    }

    child.stdout?.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr?.on("data", (d) => {
      stderr += d.toString();
    });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, code, signal, killed: child.killed });
    });
  });
}
