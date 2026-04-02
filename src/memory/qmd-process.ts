import { spawn } from "node:child_process";
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

export function resolveCliSpawnInvocation(params: {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  packageName: string;
}): CliSpawnInvocation {
  const program = resolveWindowsSpawnProgram({
    command: params.command,
    platform: process.platform,
    env: params.env,
    execPath: process.execPath,
    packageName: params.packageName,
    allowShellFallback: false,
  });
  return materializeWindowsSpawnProgram(program, params.args);
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
      detached: process.platform !== "win32",
    });
    let settled = false;
    let stdout = "";
    let stderr = "";
    let stdoutTruncated = false;
    let stderrTruncated = false;
    const discardStdout = params.discardStdout === true;
    const timer = params.timeoutMs
      ? setTimeout(() => {
          killCliChild(child);
          settled = true;
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
      if (settled) {
        return;
      }
      settled = true;
      reject(err);
    });
    child.on("close", (code) => {
      if (timer) {
        clearTimeout(timer);
      }
      if (settled) {
        return;
      }
      settled = true;
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

function killCliChild(child: { pid?: number; kill: (signal?: NodeJS.Signals) => void }): void {
  if (process.platform !== "win32" && typeof child.pid === "number" && child.pid > 0) {
    try {
      process.kill(-child.pid, "SIGKILL");
      return;
    } catch {
      // Fall back to direct kill if the process group is already gone.
    }
  }
  child.kill("SIGKILL");
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
