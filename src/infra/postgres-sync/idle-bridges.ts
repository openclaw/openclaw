import type { PostgresBridge } from "./protocol.js";

// Each isolate owns its idle transports; taking one removes it before another caller can open.
const idleBridges = new Map<
  string,
  { bridge: PostgresBridge; timeout: ReturnType<typeof setTimeout> }
>();
const maxIdleBridges = 4;
const idleBridgeTimeoutMs = 3 * 60_000;

function closeBridge(bridge: PostgresBridge): void {
  // Closing this logical endpoint releases only its independently owned socket.
  bridge.port.close();
}

function closeIdleBridges(): void {
  const bridges = [...idleBridges.values()];
  idleBridges.clear();
  unwatch();
  for (const { bridge, timeout } of bridges) {
    clearTimeout(timeout);
    closeBridge(bridge);
  }
}

function unwatch(): void {
  if (!idleBridges.size) {
    process.off("beforeExit", closeIdleBridges);
    process.off("exit", closeIdleBridges);
  }
}

export function hasIdlePostgresBridge(key: string): boolean {
  const bridge = idleBridges.get(key)?.bridge;
  return bridge !== undefined && !Atomics.load(bridge.service, 1);
}

function removeIdleBridge(key: string): PostgresBridge | undefined {
  const idle = idleBridges.get(key);
  idleBridges.delete(key);
  if (idle) {
    clearTimeout(idle.timeout);
  }
  unwatch();
  return idle?.bridge;
}

export function takeIdlePostgresBridge(key: string): PostgresBridge | undefined {
  const bridge = removeIdleBridge(key);
  if (bridge) {
    if (Atomics.load(bridge.service, 1)) {
      closeBridge(bridge);
      return undefined;
    }
  }
  return bridge;
}

export function retainIdlePostgresBridge(key: string, bridge: PostgresBridge): void {
  const previous = removeIdleBridge(key);
  if (previous) {
    closeBridge(previous);
  }
  if (idleBridges.size === maxIdleBridges) {
    const oldest = idleBridges.keys().next().value!;
    closeBridge(removeIdleBridge(oldest)!);
  }
  if (!idleBridges.size) {
    process.once("beforeExit", closeIdleBridges);
    process.once("exit", closeIdleBridges);
  }
  const timeout = setTimeout(() => {
    const expired = removeIdleBridge(key);
    if (expired) {
      closeBridge(expired);
    }
  }, idleBridgeTimeoutMs);
  timeout.unref();
  idleBridges.set(key, { bridge, timeout });
}
