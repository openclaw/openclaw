import { registerSignalExitGate } from "../cli/signal-exit-barrier.js";
import { createDeferredCore } from "../shared/deferred.js";

/** Let admitted repair work settle before restoring the service and exiting. */
export function holdDoctorMaintenanceExit(reportInterruption?: (message: string) => void) {
  const controller = new AbortController();
  const finished = createDeferredCore();
  // A failed outcome is relevant only if an exit is draining this gate.
  void finished.promise.catch(() => undefined);
  const unregister = registerSignalExitGate(finished.promise, (signal) => {
    if (controller.signal.aborted) {
      return;
    }
    const message = `Doctor interrupted${signal ? ` by ${signal}` : ""}; cancelling inspections and settling admitted repairs before exit.`;
    controller.abort(new Error(message));
    try {
      reportInterruption?.(message);
    } catch {
      // Broken output must not release the gate before admitted repairs settle.
    }
  });
  let active = true;
  const release = (failed = false) => {
    if (!active) {
      return;
    }
    active = false;
    unregister();
    if (failed) {
      finished.reject(new Error("Doctor maintenance did not complete."));
    } else {
      finished.resolve();
    }
  };
  return { signal: controller.signal, release };
}
