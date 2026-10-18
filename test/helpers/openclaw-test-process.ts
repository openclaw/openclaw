import { EventEmitter } from "node:events";
import { performance } from "node:perf_hooks";
import { PassThrough, type Readable } from "node:stream";
import { finished } from "node:stream/promises";
import { createChildAdapter } from "../../src/process/supervisor/adapters/child.js";
import { runWithProcessCleanupBudget } from "../../src/process/supervisor/cleanup-budget.js";
import type { ProcessExtinctionResult } from "../../src/process/supervisor/types.js";
import { runQaGatewayFixture } from "./qa-gateway-cleanup.js";

/** Observable command facts; the custody adapter, not this view, owns termination. */
export type OpenClawTestProcess = EventEmitter & {
  readonly pid?: number;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  killed: boolean;
  stdout: Readable;
  stderr: Readable;
  kill: (signal?: NodeJS.Signals) => boolean;
};

export async function createOpenClawTestProcess(params: {
  argv: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  gracefulShutdownTimeoutMs?: number;
  onError: (error: Error) => void;
  onSpawnCleanup: (cleanup: Promise<ProcessExtinctionResult>) => void;
}) {
  let constructionCleanup: Promise<ProcessExtinctionResult> | undefined;
  const startup = await createChildAdapter({
    argv: params.argv,
    cwd: params.cwd,
    env: params.env,
    exactEnv: true,
    ownProcessTree: true,
    stdinMode: "pipe-closed",
    abortSignal: params.signal,
    onSpawnCleanup: (cleanup) => {
      constructionCleanup = cleanup;
      params.onSpawnCleanup(cleanup);
      void cleanup.catch(() => {});
    },
  }).catch(async (error: unknown) => {
    // Construction publishes custody before readiness can fail.
    return await runQaGatewayFixture(
      async (): Promise<never> => {
        throw error;
      },
      () => constructionCleanup,
    );
  });
  const { adapter, ready } = startup;
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let shutdownTimer: NodeJS.Timeout | undefined;
  const child: OpenClawTestProcess = Object.assign(new EventEmitter(), {
    pid: adapter.pid,
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    killed: false,
    stdout,
    stderr,
    kill(signal: NodeJS.Signals = "SIGTERM") {
      child.killed = true;
      if (signal === "SIGTERM" && params.gracefulShutdownTimeoutMs !== undefined) {
        if (child.exitCode !== null || child.signalCode !== null || !adapter.pid) {
          return false;
        }
        // Let the Gateway drain its own workers before the custody owner cancels the tree.
        if (!shutdownTimer) {
          process.kill(adapter.pid, signal);
          shutdownTimer = setTimeout(
            () => adapter.kill("SIGKILL"),
            params.gracefulShutdownTimeoutMs,
          );
        }
        return true;
      }
      clearTimeout(shutdownTimer);
      adapter.kill(signal);
      return true;
    },
  });
  // Command admission may assign its PID after construction.
  Object.defineProperty(child, "pid", { get: () => adapter.pid });
  child.on("error", params.onError);
  adapter.onStdout((chunk) => stdout.write(chunk));
  adapter.onStderr((chunk) => stderr.write(chunk));
  adapter.onExit((code, signal) => {
    clearTimeout(shutdownTimer);
    child.exitCode = code;
    child.signalCode = signal;
    child.emit("exit", code, signal);
  });
  adapter.onError((error) => child.emit("error", error));
  const completion = adapter.wait().then(async (result) => {
    stdout.end();
    stderr.end();
    await Promise.all([finished(stdout), finished(stderr)]);
    child.emit("close", result.code, result.signal);
  });
  void completion.catch(() => {});
  const extinction = adapter.waitForExtinction?.();
  if (!extinction) {
    throw new Error("Gateway process custody did not provide an extinction receipt");
  }
  void extinction.catch(() => {});
  let stopped: Promise<boolean> | undefined;
  return {
    process: child,
    started: ready,
    stop: (deadline: number, warn: (message: string) => void) =>
      (stopped ??= (async () => {
        if (child.exitCode !== null || child.signalCode !== null) {
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            await Promise.race([
              completion.catch(() => undefined),
              new Promise<void>((resolve) => {
                timer = setTimeout(resolve, Math.max(0, (deadline - Date.now()) / 3));
              }),
            ]);
          } finally {
            clearTimeout(timer);
          }
        }
        runWithProcessCleanupBudget(
          { deadline: performance.now() + Math.max(0, deadline - Date.now()), warn },
          () => {
            clearTimeout(shutdownTimer);
            child.killed = true;
            adapter.kill("SIGTERM");
          },
        );
        const results = await Promise.allSettled([completion, extinction]);
        for (const result of results) {
          if (result.status === "rejected") {
            throw result.reason;
          }
        }
        adapter.dispose();
        return true;
      })()),
  };
}
