import type { Readable } from "node:stream";
import { createAwaitedDecodedOutput, onDecodedOutput } from "../decoded-output.js";

const PUSHED_OUTPUT_BUFFER_LIMIT_BYTES = 256 * 1024;

export function createOutputRelay(
  stream?: Readable,
  piped = false,
  onFailure?: () => void,
  onStreamFailure?: (error: Error) => void,
) {
  const consumer = onFailure && stream ? createAwaitedDecodedOutput(stream, onFailure) : undefined;
  const listeners = new Set<(chunk: string) => void>();
  const rawListeners = new Set<(chunk: Buffer) => void>();
  const pending: Array<string | Buffer> = [];
  let pendingBytes = 0;
  let active = false;
  let ended = false;
  let failed = false;
  const fail = (error: Error) => {
    failed = true;
    onStreamFailure?.(error);
  };
  const deliver = (chunk: string | Buffer) => {
    if (typeof chunk === "string") {
      listeners.forEach((listener) => listener(chunk));
    } else {
      rawListeners.forEach((listener) => listener(chunk));
    }
  };
  const activate = (keepOutput: boolean) => {
    if (active || piped) {
      return;
    }
    active = true;
    if (keepOutput) {
      pending.forEach(deliver);
    }
    pending.length = 0;
    pendingBytes = 0;
    stream?.resume();
  };
  const push = (chunk: string | Buffer) => {
    if (active) {
      deliver(chunk);
      return true;
    }
    const chunkBytes = Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk);
    if (!stream && pendingBytes + chunkBytes > PUSHED_OUTPUT_BUFFER_LIMIT_BYTES) {
      return false;
    }
    pending.push(chunk);
    if (!stream || Buffer.isBuffer(chunk)) {
      pendingBytes += chunkBytes;
    }
    if (stream && pendingBytes >= stream.readableHighWaterMark) {
      // POSIX can retain later output in its native pipe until subscription.
      stream.pause();
    }
    return true;
  };
  const end = () => {
    ended = true;
  };
  if (stream) {
    if (!piped && !consumer) {
      onDecodedOutput(stream, push, push);
    }
    stream.once("end", end);
    // Only end proves EOF. Keep raw failures connected through final cleanup,
    // independently of decoded subscription and awaited-consumer settlement.
    stream.on("error", fail);
    stream.once("close", () => {
      if (!ended) {
        fail(new Error("service child stream closed before EOF"));
      }
    });
  }
  return {
    get ended() {
      return ended && !failed;
    },
    push,
    end,
    subscribe: (listener: (chunk: string) => void, onRaw?: (chunk: Buffer) => void) => {
      if (consumer) {
        throw new Error("Process stdout requires its awaited consumer");
      }
      listeners.add(listener);
      if (onRaw) {
        rawListeners.add(onRaw);
      }
      activate(true);
    },
    consume: consumer?.consume,
    drain: () => (consumer ? consumer.drain() : activate(false)),
    clear: () => {
      consumer?.close();
      listeners.clear();
      rawListeners.clear();
      pending.length = 0;
      pendingBytes = 0;
    },
  };
}
