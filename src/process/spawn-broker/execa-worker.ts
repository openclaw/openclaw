import type { ChildProcess } from "node:child_process";
import { Socket } from "node:net";
import type { Transform } from "node:stream";
import { execa } from "execa";
import { createExecaOutput } from "./execa-output.js";
import {
  serializeExecaError,
  type BrokerExecaOptions,
  type BrokerExecaResult,
  type BrokerOutputOption,
} from "./execa-protocol.js";
import { holdPipeForTransfer } from "./pipe.js";

function outputOption(options: BrokerExecaOptions, fd: 1 | 2): BrokerOutputOption {
  const explicit = fd === 1 ? options.stdout : options.stderr;
  if (explicit !== undefined) {
    return explicit;
  }
  return typeof options.stdio === "string" ? options.stdio : (options.stdio?.[fd] ?? "pipe");
}

export type BrokerExecaProcess = {
  child: ChildProcess;
  stdio: (Socket | null)[];
  result: Promise<BrokerExecaResult>;
  cancel: () => void;
  kill: (signal?: NodeJS.Signals | number) => boolean;
  outputDrained: (fd: number, error?: Error) => void;
};

/** Spawn only after preparing bounded output paths, before the command can produce bytes. */
export async function startBrokerExeca(
  argv: string[],
  options: BrokerExecaOptions,
  assertCurrent: () => void,
): Promise<BrokerExecaProcess> {
  const controller = new AbortController();
  const outputs = new Map<number, { receiver: Socket; transform: Transform }>();
  try {
    for (const fd of [1, 2] as const) {
      const name = fd === 1 ? "stdout" : "stderr";
      const buffered =
        typeof options.buffer === "boolean" ? options.buffer : options.buffer?.[name];
      if (outputOption(options, fd) === "pipe" && buffered !== false) {
        outputs.set(fd, await createExecaOutput());
      }
    }
    assertCurrent();
    const { encoding, ...processOptions } = options;
    const spawnOptions = {
      ...processOptions,
      ...(outputs.has(1)
        ? { stdout: { transform: outputs.get(1)!.transform, objectMode: false as const } }
        : {}),
      ...(outputs.has(2)
        ? { stderr: { transform: outputs.get(2)!.transform, objectMode: false as const } }
        : {}),
      cancelSignal: controller.signal,
    };
    // Execa separates its text and binary option contracts at the encoding discriminant.
    const start = () =>
      encoding === undefined || encoding === "utf8" || encoding === "utf16le"
        ? execa(argv[0]!, argv.slice(1), { ...spawnOptions, encoding })
        : execa(argv[0]!, argv.slice(1), { ...spawnOptions, encoding });
    let subprocess: ReturnType<typeof start>;
    try {
      subprocess = start();
    } catch (error) {
      throw await adoptAbandonedSpawnError(error);
    }
    const child = subprocess.nodeChildProcess;
    const stdio = [0, 1, 2].map((fd) => {
      if (fd === 0 && options.input !== undefined) {
        return null;
      }
      if (fd > 0 && outputOption(options, fd === 1 ? 1 : 2) !== "pipe") {
        return null;
      }
      const stream = outputs.get(fd)?.receiver ?? child.stdio[fd];
      if (!(stream instanceof Socket)) {
        return null;
      }
      // Execa resumes unbuffered output on the next immediate; pin transfer ownership now.
      if (fd > 0) {
        holdPipeForTransfer(stream);
      }
      return stream;
    });
    const result = subprocess.then(serializeResult, (error: unknown) => {
      // Execa's promise rejects with the same result fields when reject:true.
      if (error instanceof Error && "failed" in error && error.failed === true) {
        // SAFETY: This rejection comes directly from execa, whose failed errors carry its result fields.
        return serializeResult(error as Awaited<typeof subprocess>);
      }
      throw error;
    });
    // Result delivery is attached by the broker after handing off every descriptor.
    void result.catch(() => {});
    return {
      child,
      stdio,
      result,
      cancel: () => controller.abort(),
      kill: (signal) => subprocess.kill(signal),
      outputDrained(fd, error) {
        const output = outputs.get(fd);
        if (output) {
          output.receiver.destroy();
          if (error) {
            output.transform.destroy(error);
          }
          return;
        }
        if (fd === 0 && !error) {
          child.stdin?.end();
          return;
        }
        // Transferring the native handle leaves execa's original stream awaiting close.
        child.stdio[fd]?.destroy(error);
      },
    };
  } catch (error) {
    for (const output of outputs.values()) {
      output.transform.destroy();
      output.receiver.destroy();
    }
    throw error;
  }
}

function isDescriptorSpawnError(error: unknown): error is NodeJS.ErrnoException {
  if (!(error instanceof Error)) {
    return false;
  }
  const syscall = "syscall" in error ? error.syscall : undefined;
  const code = "code" in error ? error.code : undefined;
  return (
    typeof syscall === "string" &&
    syscall.startsWith("spawn") &&
    (code === "EMFILE" || code === "ENFILE")
  );
}

// Node returns a child without stdio when spawn hits EMFILE or ENFILE and emits that error on the
// next tick. Execa reads the missing stdio first and throws, so the child it abandons has no error
// listener and its spawn error would end this worker. Claim that error for the caller instead.
async function adoptAbandonedSpawnError(thrown: unknown): Promise<unknown> {
  if (!(thrown instanceof TypeError)) {
    return thrown;
  }
  return await new Promise<unknown>((resolve) => {
    const settle = (error: unknown) => {
      process.off("uncaughtException", onUncaught);
      clearImmediate(deadline);
      resolve(error);
    };
    const onUncaught = (error: Error) => {
      if (isDescriptorSpawnError(error)) {
        settle(error);
        return;
      }
      // Anything else keeps the default fatal handling once this listener is gone.
      settle(thrown);
      process.nextTick(() => {
        throw error;
      });
    };
    process.on("uncaughtException", onUncaught);
    const deadline = setImmediate(() => settle(thrown));
  });
}

function serializeResult(result: Awaited<ReturnType<typeof execa>>): BrokerExecaResult {
  const output = {
    stdout: byteOrTextOutput(result.stdout),
    stderr: byteOrTextOutput(result.stderr),
  };
  return {
    ...output,
    exitCode: result.exitCode,
    signal: result.signal,
    failed: result.failed,
    timedOut: result.timedOut,
    isCanceled: result.isCanceled,
    isGracefullyCanceled: result.isGracefullyCanceled,
    isMaxBuffer: result.isMaxBuffer,
    isTerminated: result.isTerminated,
    isForcefullyTerminated: result.isForcefullyTerminated,
    shortMessage: result.shortMessage,
    originalMessage: result.originalMessage,
    code: result.code,
    command: result.command,
    escapedCommand: result.escapedCommand,
    cwd: result.cwd,
    durationMs: result.durationMs,
    signalDescription: result.signalDescription,
    ...(result instanceof Error ? { error: serializeExecaError(result, output) } : {}),
  };
}

function byteOrTextOutput(output: unknown): string | Uint8Array | undefined {
  if (output === undefined || typeof output === "string" || output instanceof Uint8Array) {
    return output;
  }
  throw new TypeError("Spawn broker execa output must contain bytes or text");
}
