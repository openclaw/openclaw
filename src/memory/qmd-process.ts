import { spawn } from "node:child_process";
import {
  materializeWindowsSpawnProgram,
  resolveWindowsSpawnProgram,
} from "../plugin-sdk/windows-spawn.js";
import { killProcessTree } from "../process/kill-tree.js";

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
  abortSignal?: AbortSignal;
}): Promise<{ stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    if (params.abortSignal?.aborted) {
      reject(new Error(`${params.commandSummary} aborted`));
      return;
    }
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
    let settled = false;
    const cleanup = () => {
      if (timer) {
        clearTimeout(timer);
      }
      params.abortSignal?.removeEventListener("abort", onAbort);
      child.removeAllListeners("error");
      child.removeAllListeners("close");
    };
    const rejectOnce = (err: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(err);
    };
    const resolveOnce = (value: { stdout: string; stderr: string }) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve(value);
    };
    const terminateChild = () => {
      const pid = child.pid;
      if (typeof pid === "number" && Number.isFinite(pid) && pid > 0) {
        killProcessTree(pid, { graceMs: 0 });
      } else {
        try {
          child.kill("SIGKILL");
        } catch {
          // Ignore kill failures after the child already exited.
        }
      }
      child.stdin?.destroy();
      child.stdout?.destroy();
      child.stderr?.destroy();
    };
    const onAbort = () => {
      terminateChild();
      rejectOnce(new Error(`${params.commandSummary} aborted`));
    };
    const timer = params.timeoutMs
      ? setTimeout(() => {
          terminateChild();
          rejectOnce(new Error(`${params.commandSummary} timed out after ${params.timeoutMs}ms`));
        }, params.timeoutMs)
      : null;
    params.abortSignal?.addEventListener("abort", onAbort, { once: true });
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
      rejectOnce(err instanceof Error ? err : new Error(String(err)));
    });
    child.on("close", (code) => {
      if (settled) {
        return;
      }
      if (!discardStdout && (stdoutTruncated || stderrTruncated)) {
        rejectOnce(
          new Error(
            `${params.commandSummary} produced too much output (limit ${params.maxOutputChars} chars)`,
          ),
        );
        return;
      }
      if (code === 0) {
        resolveOnce({ stdout, stderr });
      } else {
        rejectOnce(
          new Error(`${params.commandSummary} failed (code ${code}): ${stderr || stdout}`),
        );
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
