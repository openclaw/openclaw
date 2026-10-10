import { spawn, type ChildProcess } from "node:child_process";
import { sliceUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { raceWithTimeout } from "../../packages/retry/src/index.js";
import { redactSupportDiagnosticLine } from "../logging/diagnostic-support-redaction.js";
import { hasCommandProcessCleanupError } from "../process/exec-result.js";
import { signalProcessTree } from "../process/kill-tree.js";
import { resolveRuntimeArgs } from "./runtime-worker-url.js";
import { UPDATE_CANARY_PROGRESS_PREFIX } from "./update-candidate-canary-progress.js";
import type { UpdateStepResult } from "./update-step-result.js";

export function launchCanary(params: {
  entry: string;
  args: string[];
  root: string;
  env: NodeJS.ProcessEnv;
  nodeRunner?: string;
  stateDir: string;
  assertCurrent?: () => void;
  capture: (line: string) => void;
  onLine?: (line: string) => void;
  /** Receipt lines reach onLine only; they never become logs or failure reasons. */
  hidesLine?: (line: string) => boolean;
  onStdout?: (stdout: string) => void;
}) {
  const { entry, args, env, capture } = params;
  params.assertCurrent?.();
  const runtime = params.nodeRunner ?? process.execPath;
  const child = spawn(runtime, [...resolveRuntimeArgs(runtime), entry, ...args], {
    cwd: params.root,
    env,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let stdout = "";
  let lastStderrLine: string | undefined;
  const stderrLines: string[] = [];
  let fatalHeader: string | undefined;
  const stderrTail = () => (fatalHeader ? [fatalHeader, ...stderrLines] : stderrLines).join("\n");
  let cliReason: string | undefined;
  const captureStderr = (line: string) => {
    if (!line.trim() || line.startsWith(UPDATE_CANARY_PROGRESS_PREFIX)) {
      return;
    }
    const safe = redactSupportDiagnosticLine(
      line,
      { env, stateDir: params.stateDir },
      Number.MAX_SAFE_INTEGER,
    );
    lastStderrLine = sliceUtf16Safe(safe, -200);
    if (safe.startsWith("FATAL ERROR:")) {
      // A long native stack must not evict the fatal cause with earlier warnings.
      fatalHeader = sliceUtf16Safe(safe, 0, 512);
      stderrLines.length = 0;
    } else {
      stderrLines.push(sliceUtf16Safe(safe, 0, 512));
    }
    while (stderrLines.length > (fatalHeader ? 79 : 80) || stderrTail().length > 8192) {
      stderrLines.shift();
    }
    // The CLI prints a generic heading before its actual failure reason.
    if (line.startsWith("[openclaw] Reason: ")) {
      cliReason = sliceUtf16Safe(safe.replace(/^\[openclaw\] Reason: /u, ""), -200);
    }
  };
  let stdoutBytes = 0;
  let outputExceeded = false;
  const flushers = [child.stdout, child.stderr].map((stream) => {
    // Node entrypoints emit UTF-8; pipe chunks need not end at code-point boundaries.
    stream.setEncoding("utf8");
    let pending = "";
    let droppingLine = false;
    const captureLine = (line: string) => {
      if (!params.hidesLine?.(line)) {
        if (stream === child.stderr) {
          captureStderr(line);
        }
        capture(line);
      }
      params.onLine?.(line);
    };
    stream.on("data", (chunk: string) => {
      let text = chunk;
      if (droppingLine) {
        const newline = text.indexOf("\n");
        if (newline < 0) {
          return;
        }
        text = text.slice(newline + 1);
        droppingLine = false;
      }
      pending += text;
      const lines = pending.split(/\r?\n/u);
      pending = lines.pop() ?? "";
      for (const line of lines) {
        captureLine(line);
      }
      if (pending.length > 64 * 1024) {
        // Discard an oversized unterminated line whole, never through a secret.
        pending = "";
        droppingLine = true;
        if (stream === child.stderr) {
          lastStderrLine ??= "[oversized log line omitted]";
        }
        capture("[oversized log line omitted]");
      }
    });
    return () => {
      if (pending) {
        captureLine(pending);
        pending = "";
      }
    };
  });
  child.stdout.on("data", (chunk: string) => {
    stdoutBytes += Buffer.byteLength(chunk);
    if (stdoutBytes <= 1024 * 1024) {
      stdout += chunk;
      params.onStdout?.(stdout);
    } else {
      outputExceeded = true;
    }
  });
  let exited = false;
  let processExited = false;
  const result = new Promise<number | null>((resolve) => {
    child.once("exit", (code) => {
      processExited = true;
      // A failed leader cannot become a successful timeout while inherited pipes stay open.
      if (code !== 0) {
        resolve(code);
      }
    });
    child.once("error", (error) => {
      captureStderr(error.message);
      capture(error.message);
      exited = true;
      resolve(null);
    });
    child.once("close", (code) => {
      for (const flush of flushers) {
        flush();
      }
      exited = true;
      resolve(code);
    });
  });
  // Failed processes can settle validation before their inherited pipes close.
  const closed = new Promise<void>((resolve) => {
    child.once("close", () => resolve());
  });
  return {
    child,
    result,
    closed,
    hasExited: () => exited,
    processExited: () => processExited,
    stdout: () => stdout,
    stderrDiagnostic: () => fatalHeader ?? cliReason ?? lastStderrLine,
    stderrTail,
    outputExceeded: () => outputExceeded,
  };
}

export async function waitBounded<T>(
  promise: Promise<T>,
  milliseconds: number,
  signal?: AbortSignal,
): Promise<{ status: "completed"; value: T } | { status: "deadline" | "aborted" }> {
  return await raceWithTimeout(
    promise.then((value) => ({ status: "completed" as const, value })),
    Math.max(0, milliseconds),
    (): { status: "deadline" | "aborted" } => ({ status: "deadline" }),
    { signal, onAbort: () => ({ status: "aborted" }) },
  );
}

export async function terminateCanary(
  child: ChildProcess,
  closed: Promise<void>,
  deadline: number,
): Promise<boolean> {
  if (!child.pid) {
    return true;
  }
  const options = { detached: process.platform !== "win32" };
  const signal = (kind: "SIGTERM" | "SIGKILL") =>
    new Promise<void>((resolve) => {
      signalProcessTree(child.pid!, kind, { ...options, onComplete: resolve });
    });
  const term = signal("SIGTERM");
  await waitBounded(
    Promise.all([term, closed]),
    Math.min(1_000, Math.max(0, deadline - Date.now())),
  );
  // A reaped group leader does not prove its descendants have exited.
  const outcome = await waitBounded(
    Promise.all([term, signal("SIGKILL"), closed]),
    Math.min(1_000, Math.max(0, deadline - Date.now())),
  );
  return outcome.status === "completed";
}

export async function stopCanary(params: {
  running: Pick<ReturnType<typeof launchCanary>, "child" | "closed">;
  name: string;
  root: string;
  deadline: number;
  recordStep: (step: UpdateStepResult) => Promise<void>;
  primaryFailure?: unknown;
}): Promise<void> {
  const cleanupStarted = Date.now();
  try {
    if (await terminateCanary(params.running.child, params.running.closed, params.deadline)) {
      return;
    }
    await params.recordStep({
      name: `${params.name}-cleanup`,
      command: "SIGTERM, SIGKILL",
      cwd: params.root,
      durationMs: Date.now() - cleanupStarted,
      exitCode: null,
      advisory: {
        kind: "recoverable-maintenance",
        message:
          "Update cleanup deadline elapsed before process close and termination requests both completed. Update validation results are unchanged.",
      },
    });
  } catch (cleanupError) {
    if (hasCommandProcessCleanupError(params.primaryFailure)) {
      throw new AggregateError(
        [params.primaryFailure, cleanupError],
        "Candidate startup and cleanup failed",
        { cause: cleanupError },
      );
    }
    throw cleanupError;
  }
}
