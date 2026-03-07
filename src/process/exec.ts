import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { danger, shouldLogVerbose } from "../globals.js";
import { logDebug, logError } from "../logger.js";
import { resolveCommandStdio } from "./spawn-utils.js";

const execFileAsync = promisify(execFile);

/**
 * Windows cmd.exe dangerous characters that can be used for command injection.
 * Reference: Microsoft documentation on cmd.exe parsing and CVE-2024-27980
 * 
 * Characters blocked:
 * &  - Command separator (command1 & command2)
 * |  - Pipe (command1 | command2)
 * <  - Input redirection
 * >  - Output redirection
 * ^  - Escape character
 * %  - Variable expansion (%VAR%)
 * \r - Carriage return (command splitting)
 * \n - Newline (command splitting)
 * ;  - Command separator (in some contexts)
 * `  - Backtick (potential subcommand in PowerShell)
 * $  - Variable expansion (PowerShell)
 * (  - Subshell/ grouping
 * )  - Subshell/ grouping
 * [  - Alternative stream redirection (cmd.exe)
 * ]  - Alternative stream redirection (cmd.exe)
 * {  - Potential scripting
 * }  - Potential scripting
 * =  - Assignment
 * +  - Arithmetic/concatenation
 * '  - String delimiter (PowerShell)
 * "  - String delimiter (already handled by escaping)
 * \  - Path separator (can be used for UNC injection)
 * /  - Path separator/switch prefix
 * !  - Delayed expansion (cmd.exe)
 * ~  - Tilde expansion
 * *  - Wildcard
 * ?  - Wildcard
 */
const WINDOWS_UNSAFE_CMD_CHARS_RE = /[&|<>\^%\r\n;`$(){}[\]=+'\\/*?!~]/;

/**
 * Additional check for PowerShell-specific dangerous patterns.
 * Used when the command might be executed via PowerShell.
 */
const POWERSHELL_UNSAFE_PATTERNS_RE = /\b(Invoke-Expression|IEX|Invoke-Command|Start-Process|Invoke-WebRequest|DownloadFile|Add-Type|Import-Module)\b/i;

function isWindowsBatchCommand(resolvedCommand: string): boolean {
  if (process.platform !== "win32") {
    return false;
  }
  const ext = path.extname(resolvedCommand).toLowerCase();
  return ext === ".cmd" || ext === ".bat";
}

/**
 * Validates argument for Windows cmd.exe execution.
 * Throws if dangerous characters or patterns are detected.
 * 
 * SECURITY: This is a critical security check to prevent command injection
 * on Windows platforms. When shell mode is required, all arguments must
 * pass this validation.
 */
function validateWindowsArgument(arg: string, context?: string): void {
  if (WINDOWS_UNSAFE_CMD_CHARS_RE.test(arg)) {
    const charMatch = arg.match(WINDOWS_UNSAFE_CMD_CHARS_RE);
    const dangerousChar = charMatch ? charMatch[0] : "unknown";
    throw new Error(
      `Unsafe Windows cmd.exe argument detected: ${JSON.stringify(arg)}. ` +
      `Dangerous character '${dangerousChar}' found. ` +
      (context ? `Context: ${context}. ` : "") +
      "Pass an explicit shell-wrapper argv at the call site instead."
    );
  }
  
  // Additional check for PowerShell-specific patterns
  if (POWERSHELL_UNSAFE_PATTERNS_RE.test(arg)) {
    throw new Error(
      `Unsafe PowerShell pattern detected in argument: ${JSON.stringify(arg)}. ` +
      "PowerShell cmdlets like Invoke-Expression are blocked for security."
    );
  }
  
  // Check for null bytes (can truncate strings in some contexts)
  if (arg.includes('\0')) {
    throw new Error(
      `Null byte detected in argument: ${JSON.stringify(arg)}. ` +
      "Null bytes can be used to bypass security checks."
    );
  }
  
  // Check for Unicode control characters
  const controlCharMatch = arg.match(/[\u0000-\u001F\u007F-\u009F]/);
  if (controlCharMatch) {
    throw new Error(
      `Control character detected in argument (code: ${controlCharMatch[0].charCodeAt(0)}). ` +
      "Control characters are blocked for security."
    );
  }
}

/**
 * Escapes argument for safe use in Windows cmd.exe command line.
 * 
 * SECURITY: This function assumes the argument has already been validated
 * by validateWindowsArgument(). Never use this on untrusted input without
 * prior validation.
 * 
 * @param arg - The argument to escape
 * @returns Escaped argument safe for cmd.exe
 * @throws Error if argument contains dangerous characters
 */
function escapeForCmdExe(arg: string): string {
  // SECURITY: Validate before escaping
  validateWindowsArgument(arg, "escapeForCmdExe");
  
  // Quote when needed; double inner quotes for cmd parsing.
  if (!arg.includes(" ") && !arg.includes('"')) {
    return arg;
  }
  return `"${arg.replace(/"/g, '""')}"`;
}

function buildCmdExeCommandLine(resolvedCommand: string, args: string[]): string {
  return [escapeForCmdExe(resolvedCommand), ...args.map(escapeForCmdExe)].join(" ");
}

/**
 * On Windows, Node 18.20.2+ (CVE-2024-27980) rejects spawning .cmd/.bat directly
 * without shell, causing EINVAL. Resolve npm/npx to node + cli script so we
 * spawn node.exe instead of npm.cmd.
 */
function resolveNpmArgvForWindows(argv: string[]): string[] | null {
  if (process.platform !== "win32" || argv.length === 0) {
    return null;
  }
  const basename = path
    .basename(argv[0])
    .toLowerCase()
    .replace(/\.(cmd|exe|bat)$/, "");
  const cliName = basename === "npx" ? "npx-cli.js" : basename === "npm" ? "npm-cli.js" : null;
  if (!cliName) {
    return null;
  }
  const nodeDir = path.dirname(process.execPath);
  const cliPath = path.join(nodeDir, "node_modules", "npm", "bin", cliName);
  if (!fs.existsSync(cliPath)) {
    // Bun-based runs don't ship npm-cli.js next to process.execPath.
    // Fall back to npm.cmd/npx.cmd so we still route through cmd wrapper
    // (avoids direct .cmd spawn EINVAL on patched Node).
    const command = argv[0] ?? "";
    const ext = path.extname(command).toLowerCase();
    const shimmedCommand = ext ? command : `${command}.cmd`;
    return [shimmedCommand, ...argv.slice(1)];
  }
  return [process.execPath, cliPath, ...argv.slice(1)];
}

/**
 * Resolves a command for Windows compatibility.
 * On Windows, non-.exe commands (like pnpm, yarn) are resolved to .cmd; npm/npx
 * are handled by resolveNpmArgvForWindows to avoid spawn EINVAL (no direct .cmd).
 */
function resolveCommand(command: string): string {
  if (process.platform !== "win32") {
    return command;
  }
  const basename = path.basename(command).toLowerCase();
  const ext = path.extname(basename);
  if (ext) {
    return command;
  }
  const cmdCommands = ["pnpm", "yarn"];
  if (cmdCommands.includes(basename)) {
    return `${command}.cmd`;
  }
  return command;
}

/**
 * Export validation function for use by other modules.
 * Allows callers to validate arguments before passing to exec/spawn.
 * 
 * @param arg - Argument to validate
 * @param context - Optional context for error messages
 * @throws Error if argument is unsafe
 */
export function validateWindowsCommandArgument(arg: string, context?: string): void {
  validateWindowsArgument(arg, context);
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
  opts: number | { timeoutMs?: number; maxBuffer?: number; cwd?: string } = 10_000,
): Promise<{ stdout: string; stderr: string }> {
  const options =
    typeof opts === "number"
      ? { timeout: opts, encoding: "utf8" as const }
      : {
          timeout: opts.timeoutMs,
          maxBuffer: opts.maxBuffer,
          cwd: opts.cwd,
          encoding: "utf8" as const,
        };
  try {
    const argv = [command, ...args];
    let execCommand: string;
    let execArgs: string[];
    if (process.platform === "win32") {
      const resolved = resolveNpmArgvForWindows(argv);
      if (resolved) {
        execCommand = resolved[0] ?? "";
        execArgs = resolved.slice(1);
      } else {
        execCommand = resolveCommand(command);
        execArgs = args;
      }
    } else {
      execCommand = resolveCommand(command);
      execArgs = args;
    }
    const useCmdWrapper = isWindowsBatchCommand(execCommand);
    const { stdout, stderr } = useCmdWrapper
      ? await execFileAsync(
          process.env.ComSpec ?? "cmd.exe",
          ["/d", "/s", "/c", buildCmdExeCommandLine(execCommand, execArgs)],
          { ...options, windowsVerbatimArguments: true },
        )
      : await execFileAsync(execCommand, execArgs, options);
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

export function resolveCommandEnv(params: {
  argv: string[];
  env?: NodeJS.ProcessEnv;
  baseEnv?: NodeJS.ProcessEnv;
}): NodeJS.ProcessEnv {
  const baseEnv = params.baseEnv ?? process.env;
  const argv = params.argv;
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

  const mergedEnv = params.env ? { ...baseEnv, ...params.env } : { ...baseEnv };
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
  return resolvedEnv;
}

export async function runCommandWithTimeout(
  argv: string[],
  optionsOrTimeout: number | CommandOptions,
): Promise<SpawnResult> {
  const options: CommandOptions =
    typeof optionsOrTimeout === "number" ? { timeoutMs: optionsOrTimeout } : optionsOrTimeout;
  const { timeoutMs, cwd, input, env, noOutputTimeoutMs } = options;
  const { windowsVerbatimArguments } = options;
  const hasInput = input !== undefined;
  const resolvedEnv = resolveCommandEnv({ argv, env });

  const stdio = resolveCommandStdio({ hasInput, preferInherit: true });
  const finalArgv = process.platform === "win32" ? (resolveNpmArgvForWindows(argv) ?? argv) : argv;
  const resolvedCommand = finalArgv !== argv ? (finalArgv[0] ?? "") : resolveCommand(argv[0] ?? "");
  const useCmdWrapper = isWindowsBatchCommand(resolvedCommand);
  const child = spawn(
    useCmdWrapper ? (process.env.ComSpec ?? "cmd.exe") : resolvedCommand,
    useCmdWrapper
      ? ["/d", "/s", "/c", buildCmdExeCommandLine(resolvedCommand, finalArgv.slice(1))]
      : finalArgv.slice(1),
    {
      stdio,
      cwd,
      env: resolvedEnv,
      windowsVerbatimArguments: useCmdWrapper ? true : windowsVerbatimArguments,
      ...(shouldSpawnWithShell({ resolvedCommand, platform: process.platform })
        ? { shell: true }
        : {}),
    },
  );
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
