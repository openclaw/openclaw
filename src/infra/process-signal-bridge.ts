export type ProcessSignal = "SIGINT" | "SIGTERM";

const PROCESS_SIGNALS: readonly ProcessSignal[] = ["SIGINT", "SIGTERM"];

/** Bridges process signals into run cancellation so cleanup can unwind. */
export function createProcessSignalBridge() {
  const controller = new AbortController();
  let receivedSignal: ProcessSignal | undefined;
  const handlers = new Map<ProcessSignal, () => void>();
  const dispose = () => {
    for (const [signal, handler] of handlers) {
      process.off(signal, handler);
    }
    handlers.clear();
  };
  for (const signal of PROCESS_SIGNALS) {
    const handler = () => {
      receivedSignal = signal;
      controller.abort();
      dispose();
    };
    handlers.set(signal, handler);
    process.on(signal, handler);
  }
  return {
    signal: controller.signal,
    getReceivedSignal: () => receivedSignal,
    dispose,
  };
}
