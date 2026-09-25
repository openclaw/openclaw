import { registerSignalExitGate } from "../cli/signal-exit-barrier.js";
import { createDeferredCore } from "../shared/deferred.js";

/** Let admitted repair work settle before restoring the service and exiting. */
export function holdDoctorMaintenanceExit() {
  const prompts = new AbortController();
  const finished = createDeferredCore();
  // A failed outcome is relevant only if an exit is draining this gate.
  void finished.promise.catch(() => undefined);
  const unregister = registerSignalExitGate(finished.promise, () => prompts.abort());
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
  return { signal: prompts.signal, release };
}
