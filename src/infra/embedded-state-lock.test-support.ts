import type {
  createEmbeddedStateSignalBridge,
  EmbeddedStateSignal,
} from "./embedded-state-lock.js";

export function captureNativeSignalBridge(
  createBridge: () => ReturnType<typeof createEmbeddedStateSignalBridge>,
) {
  type SignalHandler = ReturnType<typeof process.listeners>[number];
  const signalNames = ["SIGINT", "SIGTERM"] as const;
  const handlers = new Map<EmbeddedStateSignal, SignalHandler>();
  let bridge: ReturnType<typeof createEmbeddedStateSignalBridge> | undefined;
  return {
    create: () => {
      if (bridge) {
        throw new Error("Signal capture fixture already owns a bridge");
      }
      const before = new Map<EmbeddedStateSignal, Set<SignalHandler>>();
      for (const signal of signalNames) {
        before.set(signal, new Set(process.listeners(signal)));
      }
      const nativeBridge = createBridge();
      bridge = nativeBridge;
      try {
        for (const signal of signalNames) {
          const added = process.listeners(signal).filter((fn) => !before.get(signal)?.has(fn));
          const handler = added[0];
          if (added.length !== 1 || !handler) {
            throw new Error(`Expected one native ${signal} handler from this bridge`);
          }
          handlers.set(signal, handler);
        }
      } catch (error) {
        nativeBridge.dispose();
        throw error;
      }
      return nativeBridge;
    },
    emit(signal: EmbeddedStateSignal) {
      const handler = handlers.get(signal);
      if (handler && process.listeners(signal).includes(handler)) {
        handler.call(process);
      }
    },
    listenerCount(signal: EmbeddedStateSignal) {
      const handler = handlers.get(signal);
      return handler && process.listeners(signal).includes(handler) ? 1 : 0;
    },
    dispose() {
      bridge?.dispose();
    },
  };
}
