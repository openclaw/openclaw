import { loggingState } from "../logging/state.js";

const processExitLeaseCleanups = new Set<() => void>();
let processExitListenerInstalled = false;

function runProcessExitLeaseCleanups(): void {
  processExitListenerInstalled = false;
  // Exit cleanup runs after CLI output routing is restored (for example after a
  // --json envelope already reached stdout). Lease release reopens the state
  // database and can emit diagnostics, so keep them on stderr to preserve
  // machine-readable stdout for the whole process lifetime.
  const previousForceConsoleToStderr = loggingState.forceConsoleToStderr;
  loggingState.forceConsoleToStderr = true;
  try {
    for (const cleanup of processExitLeaseCleanups) {
      try {
        cleanup();
      } catch {
        // Expiry still recovers a lease when synchronous process-exit cleanup loses a DB race.
      }
    }
    processExitLeaseCleanups.clear();
  } finally {
    loggingState.forceConsoleToStderr = previousForceConsoleToStderr;
  }
}

export function registerProcessExitLeaseCleanup(cleanup: () => void): () => void {
  processExitLeaseCleanups.add(cleanup);
  if (!processExitListenerInstalled) {
    process.once("exit", runProcessExitLeaseCleanups);
    processExitListenerInstalled = true;
  }
  return () => {
    processExitLeaseCleanups.delete(cleanup);
    if (processExitLeaseCleanups.size === 0 && processExitListenerInstalled) {
      process.removeListener("exit", runProcessExitLeaseCleanups);
      processExitListenerInstalled = false;
    }
  };
}
