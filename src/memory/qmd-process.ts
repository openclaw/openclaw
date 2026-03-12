import { spawn } from "node:child_process";
import path from "node:path";
import {
  materializeWindowsSpawnProgram,
  resolveWindowsSpawnProgram,
} from "../plugin-sdk/windows-spawn.js";

export type CliSpawnInvocation = {
  command: string;
  argv: string[];
  shell?: boolean;
  windowsHide?: boolean;
};

function resolveWindowsCommandShim(command: string): string {
  if (process.platform !== "win32") {
    return command;
  }
  const trimmed = command.trim();
  if (!trimmed) {
    return command;
  }
  const ext = path.extname(trimmed).toLowerCase();
  if (ext === ".cmd" || ext === ".exe" || ext === ".bat") {
    return command;
  }
  const base = path.basename(trimmed).toLowerCase();
  if (base === "qmd" || base === "mcporter") {
    return `${trimmed}.cmd`;
  }
  return command;
}

export function resolveCliSpawnInvocation(params: {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  packageName: string;
}): CliSpawnInvocation {
  const program = resolveWindowsSpawnProgram({
    command: resolveWindowsCommandShim(params.command),
    platform: process.platform,
    env: params.env,
    execPath: process.execPath,
    packageName: params.packageName,
    allowShellFallback: true,
  });
  return materializeWindowsSpawnProgram(program, params.args);
}

export function isWindowsCommandShimEinval(params: {
  err: unknown;
  command: string;
  commandBase: string;
}): boolean {
  if (process.platform !== "win32") {
    return false;
  }
  const errno = params.err as NodeJS.ErrnoException | undefined;
  if (errno?.code !== "EINVAL") {
    return false;
  }
  const escapedBase = params.commandBase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[\\\\/])${escapedBase}\\.cmd$`, "i").test(params.command);
}

export async function runCliCommand(params: {
  commandSummary: string;
  spawnInvocation: CliSpawnInvocation;
  env: NodeJS.ProcessEnv;
  cwd: string;
  timeoutMs?: number;
  maxOutputChars: number;
  discardStdout?: boolean;
}): Promise<{ stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(params.spawnInvocation.command, params.spawnInvocation.argv, {
      env: params.env,
      cwd: params.cwd,
      shell: params.spawnInvocation.shell,
      windowsHide: params.spawnInvocation.windowsHide,
    });
    let stdout = "";
    let stderr = "";
    let stdoutTruncated = false;
    let stderrTruncated = false;
    const discardStdout = params.discardStdout === true;
    const timer = params.timeoutMs
      ? setTimeout(() => {
          child.kill("SIGKILL");
          reject(new Error(`${params.commandSummary} timed out after ${params.timeoutMs}ms`));
        }, params.timeoutMs)
      : null;
    child.stdout.on("data", (data) => {
      if (discardStdout) {
        return;
      }
      const next = appendOutputWithCap(stdout, data.toString("utf8"), params.maxOutputChars);
      stdout = next.text;
      stdoutTruncated = stdoutTruncated || next.truncated;
    });
    child.stderr.on("data", (data) => {
      const next = appendOutputWithCap(stderr, data.toString("utf8"), params.maxOutputChars);
      stderr = next.text;
      stderrTruncated = stderrTruncated || next.truncated;
    });
    child.on("error", (err) => {
      if (timer) {
        clearTimeout(timer);
      }
      reject(err);
    });
    child.on("close", (code) => {
      if (timer) {
        clearTimeout(timer);
      }
      if (!discardStdout && (stdoutTruncated || stderrTruncated)) {
        reject(
          new Error(
            `${params.commandSummary} produced too much output (limit ${params.maxOutputChars} chars)`,
          ),
        );
        return;
      }
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(`${params.commandSummary} failed (code ${code}): ${stderr || stdout}`));
      }
    });
  });
}

function appendOutputWithCap(
  current: string,
  chunk: string,
  maxChars: number,
): { text: string; truncated: boolean } {
  const appended = current + chunk;
  if (appended.length <= maxChars) {
    return { text: appended, truncated: false };
  }
  return { text: appended.slice(-maxChars), truncated: true };
}
