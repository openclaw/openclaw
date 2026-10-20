import { receiveMessageOnPort, type MessagePort, type Worker } from "node:worker_threads";
import type { BridgeReply } from "./protocol.js";

type IdleBridge = {
  port: MessagePort;
  control: Int32Array;
  worker: Worker;
  requestId: number;
};

// Each isolate owns its idle transports; taking one removes it before another caller can open.
const idleBridges = new Map<string, IdleBridge>();
const maxIdleBridges = 4;

function closeBridge(bridge: IdleBridge): void {
  try {
    const id = ++bridge.requestId;
    bridge.port.postMessage({ operation: "close", id }, []);
    const deadline = performance.now() + 5_000;
    let observed: number;
    while ((observed = Atomics.load(bridge.control, 0)) !== id) {
      const remaining = deadline - performance.now();
      if (remaining <= 0 || Atomics.load(bridge.control, 1)) {
        return;
      }
      Atomics.wait(bridge.control, 0, observed, remaining);
    }
    const reply: BridgeReply | undefined = receiveMessageOnPort(bridge.port)?.message;
    if (reply?.id === id && !("error" in reply)) {
      Atomics.wait(bridge.control, 1, 0, Math.max(0, deadline - performance.now()));
    }
  } finally {
    bridge.port.close();
    void bridge.worker.terminate();
  }
}

const ignoreWorkerError = () => {};

function closeIdleBridges(): void {
  const bridges = [...idleBridges.values()];
  idleBridges.clear();
  unwatch();
  for (const bridge of bridges) {
    closeBridge(bridge);
  }
}

function unwatch(): void {
  if (!idleBridges.size) {
    process.off("beforeExit", closeIdleBridges);
    process.off("exit", closeIdleBridges);
  }
}

export function takeIdlePostgresBridge(key: string): IdleBridge | undefined {
  const bridge = idleBridges.get(key);
  idleBridges.delete(key);
  unwatch();
  if (bridge) {
    if (Atomics.load(bridge.control, 1)) {
      closeBridge(bridge);
      return undefined;
    }
    bridge.worker.off("error", ignoreWorkerError);
  }
  return bridge;
}

export function retainIdlePostgresBridge(key: string, bridge: IdleBridge): void {
  const previous = idleBridges.get(key);
  idleBridges.delete(key);
  unwatch();
  if (previous) {
    closeBridge(previous);
  }
  if (idleBridges.size === maxIdleBridges) {
    const oldest = idleBridges.entries().next().value!;
    idleBridges.delete(oldest[0]);
    closeBridge(oldest[1]);
  }
  if (!idleBridges.size) {
    process.once("beforeExit", closeIdleBridges);
    process.once("exit", closeIdleBridges);
  }
  // An idle worker error must not reach a closed logical connection or crash its parent.
  bridge.worker.on("error", ignoreWorkerError);
  idleBridges.set(key, bridge);
}
