import { execFile, spawn } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { danger, shouldLogVerbose } from "../globals.js";
import { logDebug, logError } from "../logger.js";
import { resolveCommandStdio } from "./spawn-utils.js";

const execFileAsync = promisify(execFile);

/**
 * Windows shell builtins that are implemented by cmd.exe, not as separate executables.
 * These commands require cmd.exe /c wrapping to execute properly without shell: true.
 */
const WINDOWS_SHELL_BUILTINS = new Set([
  "assoc",
  "break",
  "call",
  "cd",
  "chdir",
  "cls",
  "color",
  "copy",
  "date",
  "del",
  "dir",
  "dpath",
  "echo",
  "endlocal",
  "erase",
  "exit",
  "for",
  "ftype",
  "goto",
  "if",
  "keys",
  "md",
  "mkdir",
  "mklink",
  "move",
  "path",
  "pause",
  "popd",
  "prompt",
  "pushd",
  "rd",
  "rem",
  "ren",
  "rename",
  "rmdir",
  "set",
  "setlocal",
  "shift",
  "start",
  "time",
  "title",
  "type",
  "ver",
  "verify",
  "vol",
]);

/**
 * Checks if a command is a Windows shell builtin.
 */
function isWindowsShellBuiltin(command: string): boolean {
  const basename = path.basename(command).toLowerCase();
  return WINDOWS_SHELL_BUILTINS.has(basename);
}

/**
 * Wraps a Windows shell builtin command with cmd.exe /c to enable execution.
 * This is the security-safe alternative to shell: true — we control the wrapping
 * and only apply it to known builtins, not to arbitrary untrusted input.
 * Returns the modified argv array, or the original if no wrapping is needed.
 */
export function wrapWindowsBuiltinCommand(argv: string[], platform: NodeJS.Platform): string[] {
  if (platform !== "win32" || argv.length === 0) {
    return argv;
  }
  const command = argv[0] ?? "";
  if (!isWindowsShellBuiltin(command)) {
    return argv;
  }
  // Wrap with cmd.exe /c: arguments are passed separately so Node's spawn
  // can properly quote them. cmd.exe /c treats everything after /c as the command.
  return ["cmd.exe", "/c", ...argv];
}

/**
 * Resolves a command for Windows compatibility.
 * On Windows, non-.exe commands (like npm, pnpm) require their .cmd extension.
 */
function resolveCommand(command: string): string {
  if (process.platform !== "win32") {
    return command;
  }
  const basename = path.basename(command).toLowerCase();
  // Skip if already has an extension (.cmd, .exe, .bat, etc.)
  const ext = path.extname(basename);
  if (ext) {
    return command;
  }
  // Common npm-related commands that need .cmd extension on Windows
  const cmdCommands = ["npm", "pnpm", "yarn", "npx"];
  if (cmdCommands.includes(basename)) {
    return `${command}.cmd`;
  }
  return command;
}

export function shouldSpawnWithShell(params: {
  resolvedCommand: string;
  platform: NodeJS.Platform;
}): boolean {
  // SECURITY: never enable `shell` for argv-based execution.
  // `shell` routes through cmd.exe on Windows, which turns untrusted argv values
  // (like chat prompts passed as CLI args) into command-injection primitives.
  // If you need a shell, use an explicit shell-wrapper argv (e.g. `cmd.exe /c ...`)
  // and validate/escape at the call site.
  void params;
  return false;
}

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
    const { stdout, stderr } = await execFileAsync(resolveCommand(command), args, options);
    if (shouldLogVerbose()) {
      if (stdout.trim()) {
        logDebug(stdout.trim());
      }
      if (stderr.trim()) {
        logError(stderr.trim());
      }
    }
    return { stdout, stderr };
  } catch (err) {
    if (shouldLogVerbose()) {
      logError(danger(`Command failed: ${command} ${args.join(" ")}`));
    }
    throw err;
  }
}

export type SpawnResult = {
  pid?: number;
  stdout: string;
  stderr: string;
  code: number | null;
  signal: NodeJS.Signals | null;
  killed: boolean;
  termination: "exit" | "timeout" | "no-output-timeout" | "signal";
  noOutputTimedOut?: boolean;
};

export type CommandOptions = {
  timeoutMs: number;
  cwd?: string;
  input?: string;
  env?: NodeJS.ProcessEnv;
  windowsVerbatimArguments?: boolean;
  noOutputTimeoutMs?: number;
};

export async function runCommandWithTimeout(
  argv: string[],
  optionsOrTimeout: number | CommandOptions,
): Promise<SpawnResult> {
  const options: CommandOptions =
    typeof optionsOrTimeout === "number" ? { timeoutMs: optionsOrTimeout } : optionsOrTimeout;
  const { timeoutMs, cwd, input, env, noOutputTimeoutMs } = options;
  const { windowsVerbatimArguments } = options;
  const hasInput = input !== undefined;

  const shouldSuppressNpmFund = (() => {
    const cmd = path.basename(argv[0] ?? "");
    if (cmd === "npm" || cmd === "npm.cmd" || cmd === "npm.exe") {
      return true;
    }
    if (cmd === "node" || cmd === "node.exe") {
      const script = argv[1] ?? "";
      return script.includes("npm-cli.js");
    }
    return false;
  })();

  const mergedEnv = env ? { ...process.env, ...env } : { ...process.env };
  const resolvedEnv = Object.fromEntries(
    Object.entries(mergedEnv)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => [key, String(value)]),
  );
  if (shouldSuppressNpmFund) {
    if (resolvedEnv.NPM_CONFIG_FUND == null) {
      resolvedEnv.NPM_CONFIG_FUND = "false";
    }
    if (resolvedEnv.npm_config_fund == null) {
      resolvedEnv.npm_config_fund = "false";
    }
  }

  const stdio = resolveCommandStdio({ hasInput, preferInherit: true });
  // Wrap Windows shell builtins (echo, dir, etc.) with cmd.exe /c for proper execution.
  // This is security-safe since we only wrap known builtins, not enabling shell: true.
  const wrappedArgv = wrapWindowsBuiltinCommand(argv, process.platform);
  const resolvedCommand = resolveCommand(wrappedArgv[0] ?? "");
  const child = spawn(resolvedCommand, wrappedArgv.slice(1), {
    stdio,
    cwd,
    env: resolvedEnv,
    windowsVerbatimArguments,
    ...(shouldSpawnWithShell({ resolvedCommand, platform: process.platform })
      ? { shell: true }
      : {}),
  });
  // Spawn with inherited stdin (TTY) so tools like `pi` stay interactive when needed.
  return await new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let noOutputTimedOut = false;
    let noOutputTimer: NodeJS.Timeout | null = null;
    const shouldTrackOutputTimeout =
      typeof noOutputTimeoutMs === "number" &&
      Number.isFinite(noOutputTimeoutMs) &&
      noOutputTimeoutMs > 0;

    const clearNoOutputTimer = () => {
      if (!noOutputTimer) {
        return;
      }
      clearTimeout(noOutputTimer);
      noOutputTimer = null;
    };

    const armNoOutputTimer = () => {
      if (!shouldTrackOutputTimeout || settled) {
        return;
      }
      clearNoOutputTimer();
      noOutputTimer = setTimeout(() => {
        if (settled) {
          return;
        }
        noOutputTimedOut = true;
        if (typeof child.kill === "function") {
          child.kill("SIGKILL");
        }
      }, Math.floor(noOutputTimeoutMs));
    };

    const timer = setTimeout(() => {
      timedOut = true;
      if (typeof child.kill === "function") {
        child.kill("SIGKILL");
      }
    }, timeoutMs);
    armNoOutputTimer();

    if (hasInput && child.stdin) {
      child.stdin.write(input ?? "");
      child.stdin.end();
    }

    child.stdout?.on("data", (d) => {
      stdout += d.toString();
      armNoOutputTimer();
    });
    child.stderr?.on("data", (d) => {
      stderr += d.toString();
      armNoOutputTimer();
    });
    child.on("error", (err) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      clearNoOutputTimer();
      reject(err);
    });
    child.on("close", (code, signal) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      clearNoOutputTimer();
      const termination = noOutputTimedOut
        ? "no-output-timeout"
        : timedOut
          ? "timeout"
          : signal != null
            ? "signal"
            : "exit";
      resolve({
        pid: child.pid ?? undefined,
        stdout,
        stderr,
        code,
        signal,
        killed: child.killed,
        termination,
        noOutputTimedOut,
      });
    });
  });
}
