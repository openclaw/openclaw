// Shared child harness for CLI process suites: real Node+TSX children, one
// deadlock guard each, and failures that always carry the child's own output.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { toErrorObject } from "@openclaw/normalization-core/error-coercion";
import { resolveVitestNodeArgs } from "../../scripts/lib/vitest-process-env.mts";
import { DEFAULT_VITEST_TEST_TIMEOUT_MS } from "../../test/vitest/vitest.timeouts.js";

const OUTPUT_TAIL_CHARS = 8_000;
const DIAGNOSTIC_GRACE_MS = 200;
const diagnosticPreload = fileURLToPath(
  new URL("./cli-process-diagnostics.test-support.cjs", import.meta.url),
);

function withoutDiagnosticReadiness(stderr: string): string {
  return stderr.replace(/^\[cli-process-diagnostics\] ready pid=\d+\r?\n/gmu, "");
}

function releaseCliProcessChild(child: ChildProcessWithoutNullStreams): string[] {
  const failures: string[] = [];
  for (const release of [
    () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
    },
    () => child.stdin.destroy(),
    () => child.stdout.destroy(),
    () => child.stderr.destroy(),
  ]) {
    try {
      release();
    } catch (error) {
      // Cleanup must not replace the timeout or interaction failure that came first.
      failures.push(String(error));
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
  env: NodeJS.ProcessEnv;
  cwd?: string;
  input?: string;
  interact?: (child: ChildProcessWithoutNullStreams) => Promise<void> | void;
  onStdout?: (stdout: string) => void;
  timeoutMs?: number;
}): Promise<CliProcessChildResult> {
  const timeoutMs = params.timeoutMs ?? CLI_PROCESS_DEADLOCK_GUARD_MS;
  const executable = params.nodeExecutable ?? process.execPath;
  const supportsDiagnostics = process.platform !== "win32" && !process.versions.bun;
  // CLI children use the test runner's V8 policy without inheriting its preloads.
  const nodeArgs =
    process.versions.bun && params.nodeExecutable === undefined
      ? params.nodeArgs
      : [
          ...resolveVitestNodeArgs(params.env),
          ...(supportsDiagnostics ? ["--require", diagnosticPreload] : []),
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
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
    params.onStdout?.(stdout);
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
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
  const completed = Promise.all([closed, interaction]).then(([exit]) => exit);
  let guard: NodeJS.Timeout | undefined;
  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      let timedOut = false;
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
        let diagnosticRequest = "unavailable: preload not ready or runtime unsupported";
        const finish = () => {
          // Detached descendants can retain these pipes after their launcher dies.
          const cleanupFailures = releaseCliProcessChild(child);
          const diagnosticDump = stderr.match(
            /\[cli-process-diagnostics\] (\{"pid":[^\n]*\})\n/u,
          )?.[1];
          reject(
            new Error(
              formatCliProcessFailure({
                reason: `${reason}\nChild diagnostics: ${diagnosticRequest}; ${diagnosticDump ? "received" : "no response"}. SIGKILL cleanup attempted.${cleanupFailures.length ? ` Cleanup failures: ${cleanupFailures.join("; ")}` : ""}\n--- child diagnostics ---\n${diagnosticDump ?? "No child dump received before cleanup."}`,
                stderr: withoutDiagnosticReadiness(stderr),
                stdout,
              }),
            ),
          );
        };
        // An unhandled SIGUSR2 would terminate Node before we could inspect it.
        if (
          supportsDiagnostics &&
          stderr.includes(`[cli-process-diagnostics] ready pid=${child.pid}\n`)
        ) {
          diagnosticRequest = "SIGUSR2 was not delivered";
          try {
            if (child.kill("SIGUSR2")) {
              diagnosticRequest = `SIGUSR2 requested; grace=${DIAGNOSTIC_GRACE_MS}ms`;
              guard = setTimeout(finish, DIAGNOSTIC_GRACE_MS);
              return;
            }
          } catch (error) {
            diagnosticRequest = `request failed: ${String(error)}`;
          }
        }
        finish();
      }, timeoutMs);
      guard.unref();
    },
  )
    .catch((error: unknown) => {
      releaseCliProcessChild(child);
      throw error;
    })
    .finally(() => {
      if (guard) {
        clearTimeout(guard);
      }
    });
  return {
    code: exit.code,
    signal: exit.signal,
    stdout,
    stderr: withoutDiagnosticReadiness(stderr),
  };
}
