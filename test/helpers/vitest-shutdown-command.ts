import { fileURLToPath } from "node:url";
import { runManagedCommand } from "../../scripts/lib/managed-child-process.mts";
import type { VitestWorkerRun } from "../../scripts/lib/vitest-worker-run.mts";
import { createDeferredCore } from "../../src/shared/deferred.ts";
import { createBoundedChildOutput } from "./bounded-child-output.ts";

/** Capture fixture diagnostics without losing the managed cancellation outcome. */
export async function runVitestShutdownCommand({
  maxBytes = 2 * 1024 * 1024,
  signal,
  workerRun,
  ...options
}: Pick<
  Parameters<typeof runManagedCommand>[0],
  "args" | "cwd" | "env" | "timeoutMs" | "onReady" | "signal"
> & {
  bin?: string;
  maxBytes?: number;
  workerRun?: VitestWorkerRun;
}) {
  const stdout = createBoundedChildOutput(maxBytes);
  const stderr = createBoundedChildOutput(maxBytes);
  const controller = new AbortController();
  const workerCompletion = workerRun ? createDeferredCore<number>() : undefined;
  let borrowerCompletion: Promise<number> | undefined;
  let overflow: Error | undefined;
  try {
    const code = await runManagedCommand({
      ...options,
      bin: options.bin ?? process.execPath,
      args: workerRun
        ? [
            fileURLToPath(
              new URL("../../scripts/lib/vitest-worker-bootstrap.mts", import.meta.url),
            ),
            workerRun.descriptor.directory,
            ...(options.args ?? []),
          ]
        : options.args,
      shell: false,
      stdio: workerRun ? ["ignore", "pipe", "pipe", "ipc"] : ["ignore", "pipe", "pipe"],
      requireProcessTreeExit: process.platform !== "win32",
      signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
      onReady(child) {
        if (workerRun && workerCompletion) {
          borrowerCompletion = workerRun.borrow(child, workerCompletion.promise);
        }
        for (const [pipe, output] of [
          [child.stdout, stdout],
          [child.stderr, stderr],
        ] as const) {
          let bytes = 0;
          pipe!.on("data", (chunk: Buffer) => {
            output.append(chunk);
            bytes += chunk.byteLength;
            if (bytes > maxBytes && !overflow) {
              overflow = Object.assign(
                new Error(`Shutdown fixture output exceeded ${maxBytes} bytes`),
                { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" },
              );
              controller.abort();
            }
          });
        }
        options.onReady?.(child);
      },
    });
    workerCompletion?.resolve(code);
    await borrowerCompletion;
    return { code, stdout: stdout.text(), stderr: stderr.text() };
  } catch (cause) {
    // Cleanup failures remain primary; overflowing output must not conceal live writers.
    const aborted = cause instanceof Error && "code" in cause && cause.code === "ABORT_ERR";
    const failure = aborted && overflow ? overflow : cause;
    const error = Object.assign(failure instanceof Error ? failure : new Error(String(failure)), {
      stdout: stdout.text(),
      stderr: stderr.text(),
    });
    if (borrowerCompletion) {
      workerCompletion?.reject(error);
      await Promise.allSettled([borrowerCompletion]);
    }
    throw error;
  }
}
