import type { ChildProcess } from "node:child_process";
import { createWriteStream, write, writev } from "node:fs";
import type { Writable } from "node:stream";
import { createPipe } from "@openclaw/fs-safe/pipe";
import { toErrorObject } from "@openclaw/normalization-core/error-coercion";
import type { SpawnSecretInput } from "./supervisor/types.js";

export type SpawnStdioEntry = "ignore" | "inherit" | "ipc" | "overlapped" | "pipe" | number;

type SecretDeliveryOptions = {
  abortSignal?: AbortSignal;
};

export function prepareSecretInputStdio(
  stdio: SpawnStdioEntry[],
  secretInput: SpawnSecretInput | undefined,
):
  | {
      deliverTo: (child: ChildProcess, options?: SecretDeliveryOptions) => Promise<void>;
      [Symbol.dispose]: () => void;
    }
  | undefined {
  if (!secretInput) {
    return undefined;
  }
  if (!Number.isInteger(secretInput.fd) || secretInput.fd < 3) {
    throw new Error("secret input file descriptor must be an integer greater than 2");
  }
  while (stdio.length <= secretInput.fd) {
    stdio.push("ignore");
  }
  // Node's POSIX stdio "pipe" is a socketpair, which cannot be reopened through
  // /proc/self/fd. A real anonymous pipe supports external CLI descriptor readers
  // while preserving one-shot consumption without credential files or shell relays.
  const pipe = process.platform === "win32" ? undefined : createPipe();
  let writer = pipe?.writer;
  stdio[secretInput.fd] = pipe?.reader.fd ?? "overlapped";
  // Numeric secret descriptors keep this launch in-process; IPC cannot transfer them.
  return {
    [Symbol.dispose]() {
      pipe?.reader.close();
      writer?.close();
      writer = undefined;
    },
    async deliverTo(child, options) {
      pipe?.reader.close();
      const streamWriter = writer;
      const stream =
        streamWriter === undefined
          ? (child.stdio[secretInput.fd] as Writable | null | undefined)
          : createWriteStream("", {
              fd: streamWriter.fd,
              fs: {
                write,
                writev,
                // Native allocations are outside Node's per-worker fd registry.
                close(_fd, callback) {
                  try {
                    streamWriter.close();
                    callback(null);
                  } catch (error) {
                    callback(toErrorObject(error, "secret input close failed"));
                  }
                },
              },
            });
      writer = undefined;
      if (!stream || typeof stream.end !== "function") {
        throw new Error(`secret input file descriptor ${secretInput.fd} is unavailable`);
      }
      const abortSignal = options?.abortSignal;
      if (abortSignal?.aborted) {
        stream.destroy();
        throw new Error("secret delivery aborted");
      }
      let data: Buffer | undefined;
      try {
        data = secretInput.createData();
        // Close the writer after delivery: later readers must see EOF, never a replay.
        await new Promise<void>((resolve, reject) => {
          let settled = false;
          const settle = (error?: Error | null) => {
            if (settled) {
              return;
            }
            settled = true;
            abortSignal?.removeEventListener("abort", onAbort);
            if (error) {
              reject(error);
            } else {
              resolve();
            }
          };
          const onAbort = () => {
            stream.destroy();
            settle(new Error("secret delivery aborted"));
          };
          const onError = (error: Error) => settle(error);
          // A pipe can emit its terminal error after end's callback. Retain the
          // handler until close while only the first outcome settles delivery.
          abortSignal?.addEventListener("abort", onAbort, { once: true });
          stream.on("error", onError);
          stream.once("close", () => stream.off("error", onError));
          stream.end(data, settle);
        });
      } finally {
        data?.fill(0);
        stream.destroy();
      }
    },
  };
}
