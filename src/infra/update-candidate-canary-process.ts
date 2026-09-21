import { spawn, type ChildProcess } from "node:child_process";
import { redactSupportDiagnosticLine } from "../logging/diagnostic-support-redaction.js";
import { signalProcessTree } from "../process/kill-tree.js";

export function launchCanary(params: {
  entry: string;
  args: string[];
  root: string;
  env: NodeJS.ProcessEnv;
  nodeRunner?: string;
  stateDir: string;
  assertCurrent?: () => void;
  capture: (line: string) => void;
  onSpawn: () => void;
  onLine?: (line: string) => void;
  onStdout?: (stdout: string) => void;
}) {
  const { entry, args, env, capture } = params;
  params.assertCurrent?.();
  const child = spawn(params.nodeRunner ?? process.execPath, [entry, ...args], {
    cwd: params.root,
    env,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  params.onSpawn();
  let stdout = "";
  let firstStderrLine: string | undefined;
  let cliReason: string | undefined;
  const captureStderr = (line: string) => {
    if (!line.trim()) {
      return;
    }
    const safe = redactSupportDiagnosticLine(line, { env, stateDir: params.stateDir });
    firstStderrLine ??= safe;
    // The CLI prints a generic heading before its actual failure reason.
    if (line.startsWith("[openclaw] Reason: ")) {
      cliReason ??= safe.replace(/^\[openclaw\] Reason: /u, "");
    }
  };
  let stdoutBytes = 0;
  let outputExceeded = false;
  const flushers = [child.stdout, child.stderr].map((stream) => {
    // Node entrypoints emit UTF-8; pipe chunks need not end at code-point boundaries.
    stream.setEncoding("utf8");
    let pending = "";
    let droppingLine = false;
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
        if (stream === child.stderr) {
          captureStderr(line);
        }
        capture(line);
        params.onLine?.(line);
      }
      if (pending.length > 64 * 1024) {
        // Discard an oversized unterminated line whole, never through a secret.
        pending = "";
        droppingLine = true;
        if (stream === child.stderr) {
          firstStderrLine ??= "[oversized log line omitted]";
        }
        capture("[oversized log line omitted]");
      }
    });
    return () => {
      if (pending) {
        if (stream === child.stderr) {
          captureStderr(pending);
        }
        capture(pending);
        params.onLine?.(pending);
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
    firstStderrLine: () => cliReason ?? firstStderrLine,
    outputExceeded: () => outputExceeded,
  };
}

export async function waitBounded<T>(
  promise: Promise<T>,
  milliseconds: number,
  signal?: AbortSignal,
): Promise<{ status: "completed"; value: T } | { status: "deadline" | "aborted" }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  try {
    return await Promise.race([
      promise.then((value) => ({ status: "completed" as const, value })),
      new Promise<{ status: "deadline" | "aborted" }>((resolve) => {
        timer = setTimeout(() => resolve({ status: "deadline" }), Math.max(0, milliseconds));
        abort = () => resolve({ status: "aborted" });
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) {
          abort();
        }
      }),
    ]);
  } finally {
    clearTimeout(timer);
    if (abort) {
      signal?.removeEventListener("abort", abort);
    }
  }
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
