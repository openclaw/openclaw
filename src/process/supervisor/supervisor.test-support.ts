import { vi } from "vitest";
import type { SpawnProcessAdapter } from "./types.js";

type StubOutputSubscriber = {
  listener: (chunk: string) => void;
  onRaw?: (chunk: Buffer) => void;
};

export type StubChildAdapter = SpawnProcessAdapter<NodeJS.Signals | null> & {
  emitStdout: (chunk: string) => void;
  emitStdoutRaw: (chunk: Buffer) => void;
  emitStderr: (chunk: string) => void;
  settle: (code: number | null, signal?: NodeJS.Signals | null) => void;
  killMock: ReturnType<typeof vi.fn>;
  disposeMock: ReturnType<typeof vi.fn>;
};

export function createStubChildAdapter(options?: {
  onKill?: (signal: NodeJS.Signals | undefined, adapter: StubChildAdapter) => void;
}): StubChildAdapter {
  const stdoutSubscribers: StubOutputSubscriber[] = [];
  const stderrSubscribers: StubOutputSubscriber[] = [];
  // Mirror onDecodedOutput: one stream chunk reaches the raw subscriber before
  // its decoded sibling, so a single emit exercises both supervisor paths.
  const emitOutput = (subscribers: StubOutputSubscriber[], chunk: string) => {
    for (const subscriber of subscribers) {
      subscriber.onRaw?.(Buffer.from(chunk));
      subscriber.listener(chunk);
    }
  };
  let resolveWait:
    | ((value: { code: number | null; signal: NodeJS.Signals | null }) => void)
    | null = null;
  const waitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve) => {
      resolveWait = resolve;
    },
  );
  const killMock = vi.fn();
  const disposeMock = vi.fn();
  const adapter: StubChildAdapter = {
    pid: 1234,
    stdin: undefined,
    supportsRawOutput: true,
    onStdout: (listener, onRaw) => {
      stdoutSubscribers.push({ listener, ...(onRaw ? { onRaw } : {}) });
    },
    onStderr: (listener, onRaw) => {
      stderrSubscribers.push({ listener, ...(onRaw ? { onRaw } : {}) });
    },
    wait: async () => await waitPromise,
    kill: (signal) => {
      killMock(signal);
      options?.onKill?.(signal, adapter);
    },
    dispose: () => {
      disposeMock();
    },
    emitStdout: (chunk) => {
      emitOutput(stdoutSubscribers, chunk);
    },
    emitStdoutRaw: (chunk) => {
      for (const subscriber of stdoutSubscribers) {
        subscriber.onRaw?.(chunk);
      }
    },
    emitStderr: (chunk) => {
      emitOutput(stderrSubscribers, chunk);
    },
    settle: (code, signal = null) => {
      resolveWait?.({ code, signal });
      resolveWait = null;
    },
    killMock,
    disposeMock,
  };

  return adapter;
}
