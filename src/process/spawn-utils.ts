import type { ChildProcess, SpawnOptions } from "node:child_process";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";

export type SpawnFallback = {
  label: string;
  options: SpawnOptions;
};

export type SpawnWithFallbackResult = {
  child: ChildProcess;
  usedFallback: boolean;
  fallbackLabel?: string;
};

type SpawnWithFallbackParams = {
  argv: string[];
  options: SpawnOptions;
  fallbacks?: SpawnFallback[];
  spawnImpl?: typeof spawn;
  retryCodes?: string[];
  onFallback?: (err: unknown, fallback: SpawnFallback) => void;
};

const DEFAULT_RETRY_CODES = ["EBADF"];

export function resolveCommandStdio(params: {
  hasInput: boolean;
  preferInherit: boolean;
}): ["pipe" | "inherit" | "ignore", "pipe", "pipe"] {
  const stdin = params.hasInput ? "pipe" : params.preferInherit ? "inherit" : "pipe";
  return [stdin, "pipe", "pipe"];
}

export function formatSpawnError(err: unknown): string {
  if (!(err instanceof Error)) {
    return String(err);
  }
  const details = err as NodeJS.ErrnoException;
  const parts: string[] = [];
  const message = err.message?.trim();
  if (message) {
    parts.push(message);
  }
  if (details.code && !message?.includes(details.code)) {
    parts.push(details.code);
  }
  if (details.syscall) {
    parts.push(`syscall=${details.syscall}`);
  }
  if (typeof details.errno === "number") {
    parts.push(`errno=${details.errno}`);
  }
  return parts.join(" ");
}

function shouldRetry(err: unknown, codes: string[]): boolean {
  const code =
    err && typeof err === "object" && "code" in err ? String((err as { code?: unknown }).code) : "";
  return code.length > 0 && codes.includes(code);
}

async function spawnAndWaitForSpawn(
  spawnImpl: typeof spawn,
  argv: string[],
  options: SpawnOptions,
): Promise<ChildProcess> {
  const child = spawnImpl(argv[0], argv.slice(1), options);

  return await new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      child.removeListener("error", onError);
      child.removeListener("spawn", onSpawn);
    };
    const finishResolve = () => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve(child);
    };
    const onError = (err: unknown) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(err);
    };
    const onSpawn = () => {
      finishResolve();
    };
    child.once("error", onError);
    child.once("spawn", onSpawn);
    // Ensure mocked spawns that never emit "spawn" don't stall.
    process.nextTick(() => {
      if (typeof child.pid === "number") {
        finishResolve();
      }
    });
  });
}

/**
 * Create a fake ChildProcess that uses file-capture for stdout/stderr.
 * This is the EBADF workaround - avoids pipe creation which causes EBADF.
 * Output is captured to temp files and replayed after process completes.
 */
function createFileCaptureChild(
  spawnImpl: typeof spawn,
  argv: string[],
  options: SpawnOptions,
): ChildProcess {
  const tmpDir = os.tmpdir();
  const id = `openclaw-spawn-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const stdoutFile = path.join(tmpDir, `${id}.stdout`);
  const stderrFile = path.join(tmpDir, `${id}.stderr`);

  // Create a fake ChildProcess with readable stdout/stderr streams
  const fakeChild = new EventEmitter() as ChildProcess;
  const stdoutStream = new Readable({ read() {} });
  const stderrStream = new Readable({ read() {} });

  // Assign streams to fake child
  (fakeChild as { stdout: Readable }).stdout = stdoutStream;
  (fakeChild as { stderr: Readable }).stderr = stderrStream;
  (fakeChild as { stdin: null }).stdin = null;

  // Build shell command that redirects to files
  const escapedCommand = argv.map((arg) => `'${arg.replace(/'/g, "'\\''")}'`).join(" ");
  const wrappedCommand = `${escapedCommand} >"${stdoutFile}" 2>"${stderrFile}"`;

  // Spawn the shell with stdio: "ignore" to bypass EBADF
  const realChild = spawnImpl("/bin/sh", ["-c", wrappedCommand], {
    ...options,
    stdio: "ignore",
    detached: false,
  });

  // Forward pid
  (fakeChild as { pid: number | undefined }).pid = realChild.pid;

  // Track if we've emitted spawn
  let spawnEmitted = false;

  realChild.once("spawn", () => {
    spawnEmitted = true;
    fakeChild.emit("spawn");
  });

  realChild.once("error", (err) => {
    // Clean up temp files on error
    try {
      fs.unlinkSync(stdoutFile);
    } catch {}
    try {
      fs.unlinkSync(stderrFile);
    } catch {}

    if (!spawnEmitted) {
      fakeChild.emit("error", err);
    }
  });

  realChild.once("close", (code, signal) => {
    // Read captured output and push to streams
    const readAndPush = (file: string, stream: Readable) => {
      try {
        if (fs.existsSync(file)) {
          const data = fs.readFileSync(file, "utf8");
          if (data.length > 0) {
            stream.push(data);
          }
          fs.unlinkSync(file);
        }
      } catch {
        // Ignore read errors
      }
      stream.push(null); // Signal end of stream
    };

    readAndPush(stdoutFile, stdoutStream);
    readAndPush(stderrFile, stderrStream);

    fakeChild.emit("close", code, signal);
    fakeChild.emit("exit", code, signal);
  });

  // Add kill method
  (fakeChild as { kill: (signal?: NodeJS.Signals) => boolean }).kill = (signal) => {
    return realChild.kill(signal);
  };

  // Add connected/killed properties
  Object.defineProperty(fakeChild, "connected", {
    get: () => realChild.connected,
  });
  Object.defineProperty(fakeChild, "killed", {
    get: () => realChild.killed,
  });
  Object.defineProperty(fakeChild, "exitCode", {
    get: () => realChild.exitCode,
  });
  Object.defineProperty(fakeChild, "signalCode", {
    get: () => realChild.signalCode,
  });

  return fakeChild;
}

async function spawnWithFileCapture(
  spawnImpl: typeof spawn,
  argv: string[],
  options: SpawnOptions,
): Promise<ChildProcess> {
  const child = createFileCaptureChild(spawnImpl, argv, options);

  return await new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      child.removeListener("error", onError);
      child.removeListener("spawn", onSpawn);
    };
    const finishResolve = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(child);
    };
    const onError = (err: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };
    const onSpawn = () => {
      finishResolve();
    };
    child.once("error", onError);
    child.once("spawn", onSpawn);
    // Handle case where child already has a pid (sync spawn)
    process.nextTick(() => {
      if (typeof child.pid === "number" && !settled) {
        finishResolve();
      }
    });
  });
}

export async function spawnWithFallback(
  params: SpawnWithFallbackParams,
): Promise<SpawnWithFallbackResult> {
  const spawnImpl = params.spawnImpl ?? spawn;
  const retryCodes = params.retryCodes ?? DEFAULT_RETRY_CODES;
  const baseOptions = { ...params.options };
  const fallbacks = params.fallbacks ?? [];

  // Build attempt list: user options, user fallbacks, then file-capture fallback
  const attempts: Array<{
    label?: string;
    options: SpawnOptions;
    useFileCapture?: boolean;
  }> = [
    { options: baseOptions },
    ...fallbacks.map((fallback) => ({
      label: fallback.label,
      options: { ...baseOptions, ...fallback.options },
    })),
    // Final fallback: file-capture to bypass EBADF on pipe creation
    { label: "file-capture", options: baseOptions, useFileCapture: true },
  ];

  let lastError: unknown;
  for (let index = 0; index < attempts.length; index += 1) {
    const attempt = attempts[index];
    try {
      let child: ChildProcess;
      if (attempt.useFileCapture) {
        // Use async file-capture fallback (EBADF workaround)
        child = await spawnWithFileCapture(spawnImpl, params.argv, attempt.options);
      } else {
        child = await spawnAndWaitForSpawn(spawnImpl, params.argv, attempt.options);
      }
      return {
        child,
        usedFallback: index > 0,
        fallbackLabel: attempt.label,
      };
    } catch (err) {
      lastError = err;
      const isLastAttempt = index === attempts.length - 1;
      if (isLastAttempt || !shouldRetry(err, retryCodes)) {
        throw err;
      }
      // Notify about fallback
      const nextAttempt = attempts[index + 1];
      if (nextAttempt?.label) {
        params.onFallback?.(err, { label: nextAttempt.label, options: nextAttempt.options });
      }
    }
  }

  throw lastError;
}
