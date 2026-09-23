import { exitAfterSignalExitBarriers, registerSignalExitGate } from "../cli/signal-exit-barrier.js";
import { hasErrnoCode } from "../infra/errno.js";
import { createDeferredCore } from "../shared/deferred.js";

/** Let admitted repair work settle before restoring the service and exiting. */
export function holdDoctorMaintenanceExit() {
  const prompts = new AbortController();
  const finished = createDeferredCore();
  // A failed outcome is relevant only if an exit is draining this gate.
  void finished.promise.catch(() => undefined);
  const unregister = registerSignalExitGate(finished.promise);
  const interrupt = (code: number) => {
    prompts.abort();
    exitAfterSignalExitBarriers(code);
  };
  const onSigint = () => interrupt(130);
  const onSigterm = () => interrupt(143);
  const onSigpipe = () => interrupt(141);
  const onOutputError = (error: unknown) => {
    if (hasErrnoCode(error, "EPIPE") || hasErrnoCode(error, "EIO")) {
      prompts.abort();
    }
  };
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);
  process.on("SIGPIPE", onSigpipe);
  process.stdout.on("error", onOutputError);
  process.stderr.on("error", onOutputError);
  let active = true;
  const release = (failed = false) => {
    if (!active) {
      return;
    }
    active = false;
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
    process.off("SIGPIPE", onSigpipe);
    process.stdout.off("error", onOutputError);
    process.stderr.off("error", onOutputError);
    unregister();
    if (failed) {
      finished.reject(new Error("Doctor maintenance did not complete."));
    } else {
      finished.resolve();
    }
  };
  return { signal: prompts.signal, release };
}
