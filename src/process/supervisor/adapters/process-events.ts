import type { Readable } from "node:stream";
import { onDecodedOutput } from "../../decoded-output.js";
import type { SpawnProcessAdapter } from "../types.js";

type ProcessEvents = Required<
  Pick<SpawnProcessAdapter<NodeJS.Signals | null>, "onExit" | "onError">
>;
type ErrorListener = Parameters<ProcessEvents["onError"]>[0];

const PUSHED_OUTPUT_BUFFER_LIMIT_BYTES = 256 * 1024;

/** Preserve terminal facts and startup errors until the transport owner subscribes. */
export function createProcessAdapterEvents() {
  let exit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  const exitListeners = new Set<Parameters<ProcessEvents["onExit"]>[0]>();
  const errorListeners = new Set<ErrorListener>();
  const pendingErrors = new Map<Parameters<ErrorListener>[1], Error>();
  return {
    onExit: (listener: Parameters<ProcessEvents["onExit"]>[0]) => {
      exitListeners.add(listener);
      if (exit) {
        listener(exit.code, exit.signal);
      }
    },
    onError: (listener: ErrorListener) => {
      errorListeners.add(listener);
      for (const [source, error] of pendingErrors) {
        listener(error, source);
      }
      pendingErrors.clear();
    },
    emitExit: (code: number | null, signal: NodeJS.Signals | null) => {
      exit = { code, signal };
      for (const listener of exitListeners) {
        listener(code, signal);
      }
    },
    emitError: (error: Error, source: Parameters<ErrorListener>[1]) => {
      if (errorListeners.size === 0) {
        if (!pendingErrors.has(source)) {
          pendingErrors.set(source, error);
        }
      } else {
        for (const listener of errorListeners) {
          listener(error, source);
        }
      }
    },
    clear: () => {
      exitListeners.clear();
      errorListeners.clear();
      pendingErrors.clear();
    },
  };
}

export function createOutputRelay(stream?: Readable, piped = false) {
  const listeners = new Set<(chunk: string) => void>();
  const rawListeners = new Set<(chunk: Buffer) => void>();
  const pending: Array<string | Buffer> = [];
  let pendingBytes = 0;
  let active = false;
  let ended = false;
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
    if (!piped) {
      onDecodedOutput(stream, push, push);
    }
    stream.once("end", end);
    stream.once("close", end);
  }
  return {
    get ended() {
      return ended;
    },
    push,
    end,
    subscribe: (listener: (chunk: string) => void, onRaw?: (chunk: Buffer) => void) => {
      listeners.add(listener);
      if (onRaw) {
        rawListeners.add(onRaw);
      }
      activate(true);
    },
    drain: () => activate(false),
    clear: () => {
      listeners.clear();
      rawListeners.clear();
      pending.length = 0;
      pendingBytes = 0;
    },
  };
}
