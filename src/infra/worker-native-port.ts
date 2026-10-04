import type { MessagePort } from "node:worker_threads";

const livePort = new Error("Native worker port validation reached the live sentinel");
// This private identity sentinel must not retain the first importer's stack.
livePort.stack = undefined;
const portValidation = {
  get value(): never {
    throw livePort;
  },
};

export function nativePortIsOpen(port: MessagePort): boolean {
  if (process.versions.bun) {
    const referenced = port.hasRef();
    port.unref();
    port.ref();
    const open = port.hasRef();
    if (!referenced) {
      port.unref();
    }
    return open;
  }
  try {
    // Node validates the transfer list before reading properties, then commits
    // transfers only after serialization. Our private throw leaves live ports
    // untouched; drained close control rejects before reaching that getter.
    structuredClone(portValidation, { transfer: [port] });
  } catch (error) {
    if (error === livePort) {
      return true;
    }
    if (error instanceof DOMException && error.name === "DataCloneError") {
      return false;
    }
    throw error;
  }
  throw new Error("Native port validation did not abort serialization");
}
