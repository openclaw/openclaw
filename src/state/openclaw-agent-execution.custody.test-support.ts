import type { Worker, WorkerOptions } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { createDeferred } from "../../test/helpers/promise.js";

/** Hold a real worker path lookup while the host retires its request owner. */
export function createWorkerSourceLookupGate(pathname: string) {
  const control = new Int32Array(new SharedArrayBuffer(8));
  const entered = createDeferred();
  const preload = `
    import fs from "node:fs";
    import { syncBuiltinESMExports } from "node:module";
    import { parentPort, workerData } from "node:worker_threads";
    const realpath = fs.realpathSync.native;
    const control = new Int32Array(workerData.sourceLookupGate);
    fs.realpathSync.native = function(pathname, ...args) {
      if (pathname === workerData.sourceLookupPath &&
          Atomics.compareExchange(control, 0, 1, 2) === 1) {
        parentPort.postMessage({ type: "test-source-lookup" });
        Atomics.wait(control, 1, 0);
      }
      return realpath.call(this, pathname, ...args);
    };
    syncBuiltinESMExports();
  `;
  return {
    entered: entered.promise,
    arm: () => Atomics.store(control, 0, 1),
    release() {
      Atomics.store(control, 1, 1);
      Atomics.notify(control, 1);
    },
    options(options?: WorkerOptions): WorkerOptions {
      return {
        ...options,
        execArgv: [
          ...(options?.execArgv ?? []),
          "--import",
          `data:text/javascript,${encodeURIComponent(preload)}`,
        ],
        workerData: {
          ...options?.workerData,
          sourceLookupGate: control.buffer,
          sourceLookupPath: pathname,
        },
      };
    },
    message(message: unknown) {
      if (!isRecord(message) || message.type !== "test-source-lookup") {
        return false;
      }
      entered.resolve();
      return true;
    },
  };
}

export function observeWorkerSourceLookups(
  Constructor: typeof Worker,
  current: () => ReturnType<typeof createWorkerSourceLookupGate> | undefined,
): typeof Worker {
  return class extends Constructor {
    private readonly gate: ReturnType<typeof current>;
    constructor(filename: string | URL, options?: WorkerOptions) {
      const gate = current();
      super(filename, gate?.options(options) ?? options);
      this.gate = gate;
    }
    override emit(event: string | symbol, ...args: unknown[]) {
      return event === "message" && this.gate?.message(args[0]) ? true : super.emit(event, ...args);
    }
  };
}
