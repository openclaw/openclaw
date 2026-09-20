// Shared child harness for CLI process suites: real Node+TSX children, one
// deadlock guard each, and failures that always carry the child's own output.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { toErrorObject } from "@openclaw/normalization-core/error-coercion";
import { onTestFinished } from "vitest";
import {
  collectNodeDiagnosticReport,
  NODE_DIAGNOSTIC_REPORT_GRACE_MS as REPORT_GRACE_MS,
} from "../../scripts/lib/node-diagnostic-report.mts";
import { resolveVitestNodeArgs } from "../../scripts/lib/vitest-process-env.mts";
import { createFixtureLifetime } from "../../test/helpers/fixture-lifetime.js";
import { stopChildProcess } from "../../test/helpers/stop-child-process.js";
import { DEFAULT_VITEST_TEST_TIMEOUT_MS } from "../../test/vitest/vitest.timeouts.js";
import { createDeferredCore } from "../shared/deferred.js";
import { captureCliProcessTree } from "./cli-process-tree.test-support.js";

const OUTPUT_TAIL_CHARS = 8_000;
const DIAGNOSTIC_GRACE_MS = 200;
const CLEANUP_TIMEOUT_MS = 5_000;
const TEST_SETUP_AND_ASSERTION_MARGIN_MS = 5_000;
const diagnosticPreload = fileURLToPath(
  new URL("./cli-process-diagnostics.test-support.cjs", import.meta.url),
);

function withoutDiagnosticReadiness(stderr: string): string {
  return stderr.replace(/^\[cli-process-diagnostics\] ready pid=\d+\r?\n/gmu, "");
}

async function releaseCliProcessChild(child: ChildProcessWithoutNullStreams): Promise<string[]> {
  const failures: string[] = [];
  const pipes = [child.stdin, child.stdout, child.stderr];
  const deadlineAt = performance.now() + CLEANUP_TIMEOUT_MS;
  const eofWait = new AbortController();
  const deadline = setTimeout(() => eofWait.abort(), CLEANUP_TIMEOUT_MS);
  const ended = Promise.all(
    (["stdout", "stderr"] as const).map(async (name) => {
      try {
        if (!child[name].readableEnded) {
          await once(child[name], "end", { signal: eofWait.signal });
        }
        return undefined;
      } catch (error) {
        return `CLI child ${name} did not reach EOF before cleanup: ${String(error)}`;
      }
    }),
  );
  try {
    try {
      await stopChildProcess(child, CLEANUP_TIMEOUT_MS, { force: true });
    } catch (error) {
      failures.push(String(error));
    }
    // Local destruction cannot prove an inherited writer released its output.
    if (failures.length === 0) {
      failures.push(...(await ended).filter((error) => error !== undefined));
    }
  } finally {
    clearTimeout(deadline);
    eofWait.abort();
    await ended;
    const closeWait = new AbortController();
    const closeDeadline = setTimeout(
      () => closeWait.abort(),
      Math.max(1, deadlineAt - performance.now()),
    );
    const closed = Promise.allSettled(
      pipes
        .filter((pipe) => !pipe.closed)
        .map((pipe) => once(pipe, "close", { signal: closeWait.signal })),
    );
    try {
      for (const pipe of pipes) {
        try {
          pipe.destroy();
        } catch (error) {
          failures.push(String(error));
        }
      }
      for (const result of await closed) {
        if (result.status === "rejected") {
          failures.push(String(result.reason));
        }
      }
    } finally {
      clearTimeout(closeDeadline);
      closeWait.abort();
    }
  }
  return failures;
}

/**
 * Deadlock guard for one CLI child, never a startup SLO.
 *
 * A source child cold-loads the whole command graph through TSX: seconds when the
 * transpile cache is warm, tens of seconds on a cold checkout or a contended runner,
 * while these suites assert output and exit codes rather than latency. Sizing the
 * guard one case below the shared Vitest deadline keeps the SIGKILL and its captured
 * output ahead of the framework's opaque timeout. Cases stay at one child each so
 * this single budget applies to all of them.
 */
export const CLI_PROCESS_DEADLOCK_GUARD_MS = DEFAULT_VITEST_TEST_TIMEOUT_MS - 20_000;

/** A sequential test stops at its first timed-out child, so reserve one diagnostic drain and cleanup. */
export function getCliProcessTestTimeout(
  childTimeoutMs: number,
  ...additionalChildTimeoutsMs: number[]
): number {
  return (
    additionalChildTimeoutsMs.reduce((total, timeoutMs) => total + timeoutMs, childTimeoutMs) +
    Math.max(DIAGNOSTIC_GRACE_MS, REPORT_GRACE_MS) +
    CLEANUP_TIMEOUT_MS +
    TEST_SETUP_AND_ASSERTION_MARGIN_MS
  );
}

export type CliProcessChildResult = {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
};

function formatOutputTail(stream: string): string {
  const truncatedLength = stream.length - OUTPUT_TAIL_CHARS;
  return truncatedLength > 0
    ? `[... truncated ${truncatedLength} chars ...]\n${stream.slice(-OUTPUT_TAIL_CHARS)}`
    : stream;
}

/** Renders a child failure with both output tails so CI shows the last startup step. */
export function formatCliProcessFailure(params: {
  reason: string;
  stdout: string;
  stderr: string;
}): string {
  return `${params.reason}\n--- child stderr (tail) ---\n${formatOutputTail(
    params.stderr,
  )}\n--- child stdout (tail) ---\n${formatOutputTail(params.stdout)}`;
}

/** Observe a marker without taking ownership of the shared stderr pipe. */
export function waitForCliProcessStderrMarker(
  child: ChildProcessWithoutNullStreams,
  marker: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let stderr = "";
    const cleanup = () => {
      child.stderr.off("data", onData);
      child.stderr.off("end", onEnd);
      child.stderr.off("close", onClose);
      child.stderr.off("error", onError);
      child.off("error", onError);
    };
    const fail = (reason: string, cause?: Error) => {
      cleanup();
      reject(
        new Error(`CLI stderr ${reason} before marker ${JSON.stringify(marker)}\n${stderr}`, {
          cause,
        }),
      );
    };
    const onData = (chunk: string | Buffer) => {
      stderr += chunk.toString();
      if (stderr.includes(marker)) {
        cleanup();
        resolve();
      }
    };
    const onEnd = () => fail("ended");
    const onClose = () => fail("closed");
    const onError = (error: Error) => fail(`failed: ${error.message}`, error);
    child.stderr.on("data", onData);
    child.stderr.once("end", onEnd);
    child.stderr.once("close", onClose);
    child.stderr.once("error", onError);
    child.once("error", onError);
    if (child.stderr.readableEnded || child.stderr.destroyed) {
      onEnd();
    }
  });
}

/** Runs one CLI child to completion under {@link CLI_PROCESS_DEADLOCK_GUARD_MS}. */
export async function runCliProcessChild(params: {
  nodeArgs: string[];
  nodeExecutable?: string;
  /** Preserve the launch policy of fixtures migrated from direct child_process calls. */
  nodeArgsPolicy?: "vitest" | "caller";
  env: NodeJS.ProcessEnv;
  cwd?: string;
  input?: string;
  interact?: (child: ChildProcessWithoutNullStreams) => Promise<void> | void;
  onStdout?: (stdout: string) => void;
  timeoutMs?: number;
  maxBuffer?: number;
}): Promise<CliProcessChildResult> {
  const timeoutMs = params.timeoutMs ?? CLI_PROCESS_DEADLOCK_GUARD_MS;
  const executable = params.nodeExecutable ?? process.execPath;
  const supportsDiagnostics = process.platform !== "win32" && !process.versions.bun;
  const reports = supportsDiagnostics ? createFixtureLifetime() : undefined;
  let unjoinedWork = false;
  if (reports) {
    onTestFinished(async () => {
      if (!unjoinedWork) {
        await reports.cleanup();
      }
    });
  }
  const reportDir = reports?.createTempDir("openclaw-cli-report-");
  // CLI children use the test runner's V8 policy without inheriting its preloads.
  const nodeArgs =
    process.versions.bun && params.nodeExecutable === undefined
      ? params.nodeArgs
      : [
          ...(params.nodeArgsPolicy === "caller" ? [] : resolveVitestNodeArgs(params.env)),
          ...(reportDir
            ? [
                "--require",
                diagnosticPreload,
                "--report-on-signal",
                "--report-signal=SIGUSR2",
                `--report-directory=${reportDir}`,
                "--report-filename=diagnostic.json",
                "--report-exclude-env",
                "--report-exclude-network",
              ]
            : []),
          ...params.nodeArgs,
        ];
  const child = spawn(executable, nodeArgs, {
    cwd: params.cwd ?? path.resolve("."),
    env: params.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let stdout = "";
  let stderr = "";
  let collectingOutput = true;
  let timedOut = false;
  const outputFailure = createDeferredCore<never>();
  const checkOutputLimit = () => {
    if (
      params.maxBuffer !== undefined &&
      Buffer.byteLength(stdout) + Buffer.byteLength(withoutDiagnosticReadiness(stderr)) >
        params.maxBuffer
    ) {
      outputFailure.reject(
        new Error(
          formatCliProcessFailure({
            reason: `CLI process exceeded maxBuffer (${params.maxBuffer} bytes)`,
            stdout,
            stderr: withoutDiagnosticReadiness(stderr),
          }),
        ),
      );
    }
  };
  child.stdout.on("data", (chunk: string) => {
    if (!collectingOutput) {
      return;
    }
    stdout += chunk;
    checkOutputLimit();
    if (!timedOut) {
      params.onStdout?.(stdout);
    }
  });
  child.stderr.on("data", (chunk: string) => {
    if (!collectingOutput) {
      return;
    }
    stderr += chunk;
    checkOutputLimit();
  });

  // Wait for stream EOF alongside exit: a respawning entrypoint hands its pipes
  // to a detached grandchild, and only EOF proves the command's output is complete.
  const closed = Promise.all([
    once(child, "exit"),
    once(child.stdout, "end"),
    once(child.stderr, "end"),
  ]).then(([[code, signal]]) => ({
    code: code as number | null,
    signal: signal as NodeJS.Signals | null,
  }));
  const interaction = (async () => {
    if (params.interact) {
      await params.interact(child);
      return;
    }
    child.stdin.end(params.input);
  })();
  const completed = Promise.race([
    Promise.all([closed, interaction]).then(([exit]) => exit),
    outputFailure.promise,
  ]);
  let guard: NodeJS.Timeout | undefined;
  const completion = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      void completed.then(
        (result) => {
          if (!timedOut) {
            resolve(result);
          }
        },
        (error: unknown) => {
          if (!timedOut) {
            reject(toErrorObject(error, "CLI child process failed"));
          }
        },
      );
      guard = setTimeout(() => {
        // The deadline is final: even an exit during diagnostic grace remains a failure.
        timedOut = true;
        const reason = `CLI process did not exit before the ${timeoutMs}ms deadlock guard (exitCode=${child.exitCode} signalCode=${child.signalCode})`;
        const processTree = captureCliProcessTree(child.pid);
        let diagnosticRequest = "unavailable: preload not ready or runtime unsupported";
        const finish = (
          report = "Node diagnostic report unavailable: signal was not requested.",
        ) => {
          const diagnosticDump = stderr.match(
            /\[cli-process-diagnostics\] (\{"pid":[^\n]*\})\n/u,
          )?.[1];
          void processTree.then((tree) =>
            reject(
              new Error(
                formatCliProcessFailure({
                  reason: `${reason}\nChild diagnostics: ${diagnosticRequest}; ${diagnosticDump ? "received" : "no response"}. SIGKILL cleanup attempted.\n--- process tree at deadline ---\n${tree}\n--- Node diagnostic report ---\n${report}\n--- child diagnostics ---\n${diagnosticDump ?? "No child dump received before cleanup."}`,
                  stderr: withoutDiagnosticReadiness(stderr),
                  stdout,
                }),
              ),
            ),
          );
        };
        void processTree.then(() => {
          // An unhandled SIGUSR2 would terminate Node before we could inspect it.
          if (reportDir && stderr.includes(`[cli-process-diagnostics] ready pid=${child.pid}\n`)) {
            diagnosticRequest = "SIGUSR2 was not delivered";
            try {
              if (child.kill("SIGUSR2")) {
                diagnosticRequest = `SIGUSR2 requested; report grace<=${REPORT_GRACE_MS}ms`;
                // Preserve the child's JS diagnostic and trailing pipe output grace.
                void collectNodeDiagnosticReport(
                  path.join(reportDir, "diagnostic.json"),
                  DIAGNOSTIC_GRACE_MS,
                ).then(finish);
                return;
              }
            } catch (error) {
              diagnosticRequest = `request failed: ${String(error)}`;
            }
          }
          finish();
        });
      }, timeoutMs);
      guard.unref();
    },
  )
    .finally(() => {
      if (guard) {
        clearTimeout(guard);
      }
    })
    .catch(async (error: unknown) => {
      collectingOutput = false;
      const cleanupFailures = await releaseCliProcessChild(child);
      if (cleanupFailures.length) {
        unjoinedWork = true;
        throw Object.assign(
          new Error(`${String(error)}\nCleanup failures: ${cleanupFailures.join("; ")}`, {
            cause: error,
          }),
          { processTreeState: "indeterminate", pid: child.pid },
        );
      }
      throw error;
    });
  const exit = await (reports ? reports.track(completion) : completion);
  return {
    code: exit.code,
    signal: exit.signal,
    stdout,
    stderr: withoutDiagnosticReadiness(stderr),
  };
}
