import { formatCliCommand } from "../cli/command-format.js";
import { registerSignalExitGate } from "../cli/signal-exit-barrier.js";
import { createDeferredCore } from "../shared/deferred.js";

export function formatDoctorRecoveryHint(env: NodeJS.ProcessEnv): string {
  return `Keep the Gateway stopped until Doctor (PID ${process.pid}) and its repair children have exited. Resolve any storage or cleanup failure, then run \`${formatCliCommand("openclaw doctor --fix", env)}\` to finish and verify repairs. After repair succeeds, run \`${formatCliCommand("openclaw gateway status --deep", env)}\`; if still stopped, run \`${formatCliCommand("openclaw gateway start", env)}\`.`;
}

/** Let admitted repair work settle before restoring the service and exiting. */
export function holdDoctorMaintenanceExit(reportInterruption?: (message: string) => void) {
  const controller = new AbortController();
  const finished = createDeferredCore();
  // A failed outcome is relevant only if an exit is draining this gate.
  void finished.promise.catch(() => undefined);
  const unregister = registerSignalExitGate(finished.promise, (signal, reason) => {
    if (controller.signal.aborted) {
      return;
    }
    const cause = signal ?? reason;
    const message = `Doctor interrupted${cause ? ` by ${cause}` : ""}; cancelling inspections and settling admitted repairs before exit.`;
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
