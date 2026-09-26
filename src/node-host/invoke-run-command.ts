import fs from "node:fs";
import path from "node:path";
import { runCommandWithTimeout } from "../process/exec.js";
import type { RunResult } from "./invoke-types.js";

const OUTPUT_CAP = 200_000;

// libuv reports a failed pre-exec `chdir(cwd)` as `spawn <argv0> ENOENT`, which
// blames the shell/command instead of the missing working directory (#85202).
// When the spawn cwd is set but is not a usable directory, name the real cause.
// Diagnostic only: the run still fails closed — the cwd is never dropped to fall
// back to the node's default directory.
function clarifyNodeExecCwdSpawnError(
  error: NodeJS.ErrnoException,
  cwd: string | undefined,
): string {
  const message = error.message;
  if (!cwd || (error.code && error.code !== "ENOENT" && error.code !== "ENOTDIR")) {
    return message;
  }
  let reason: "does not exist" | "is not a directory";
  try {
    const stats = fs.statSync(cwd);
    // An existing directory means the cwd is fine and the ENOENT is about the
    // executable itself; leave the original message untouched.
    if (stats.isDirectory()) {
      return message;
    }
    reason = "is not a directory";
  } catch (statError) {
    // SAFETY: statSync reports filesystem failures as Node errno exceptions.
    const statCode = (statError as NodeJS.ErrnoException).code;
    if (statCode !== "ENOENT" && statCode !== "ENOTDIR") {
      return message;
    }
    reason =
      statCode === "ENOTDIR" || error.code === "ENOTDIR" ? "is not a directory" : "does not exist";
  }
  return `node exec working directory ${reason} on the node host: ${cwd} (os reported: ${message})`;
}

type CommandLaunch = {
  argv: string[];
  windowsVerbatimArguments?: true;
};

// Node quotes Windows arguments with the MSVCRT convention and escapes inner quotes
// as \", which cmd.exe does not understand. `cmd.exe /s /c` strips only the first and
// last quote character of the remainder, so the node shell envelope is launched
// verbatim with one outer pair, as Node's own `shell` option does.
function resolveCommandLaunch(argv: string[]): CommandLaunch {
  if (process.platform !== "win32" || argv.length !== 5) {
    return { argv };
  }
  const [shell, noAutoRun, stripQuotes, runAndExit, command] = argv;
  if (
    shell === undefined ||
    command === undefined ||
    path.win32.basename(shell).toLowerCase() !== "cmd.exe" ||
    noAutoRun !== "/d" ||
    stripQuotes !== "/s" ||
    runAndExit !== "/c"
  ) {
    return { argv };
  }
  return {
    argv: [shell, noAutoRun, stripQuotes, runAndExit, `"${command}"`],
    windowsVerbatimArguments: true,
  };
}

export async function runCommand(
  argv: string[],
  cwd: string | undefined,
  env: Record<string, string> | undefined,
  timeoutMs: number | undefined,
  signal?: AbortSignal,
  assertCurrent?: () => void,
): Promise<RunResult> {
  assertCurrent?.();
  try {
    const launch = resolveCommandLaunch(argv);
    const result = await runCommandWithTimeout(launch.argv, {
      ...(launch.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
      baseEnv: env,
      cwd,
      killProcessTree: true,
      maxCombinedOutputBytes: OUTPUT_CAP,
      maxOutputBytes: OUTPUT_CAP,
      outputCapture: "head",
      input: Buffer.alloc(0),
      signal,
      timeoutMs: timeoutMs && timeoutMs > 0 ? timeoutMs : undefined,
    });
    const timedOut = result.termination === "timeout";
    const exitCode = result.code ?? undefined;
    return {
      exitCode,
      timedOut,
      success: exitCode === 0 && !timedOut,
      stdout: result.stdout,
      stderr: result.stderr,
      error: null,
      truncated: Boolean(result.stdoutTruncatedBytes || result.stderrTruncatedBytes),
    };
  } catch (err) {
    return {
      exitCode: undefined,
      timedOut: false,
      success: false,
      stdout: "",
      stderr: "",
      // SAFETY: the command runner rejects with an Error; errno fields are optional.
      error: clarifyNodeExecCwdSpawnError(err as NodeJS.ErrnoException, cwd),
      truncated: false,
    };
  }
}
