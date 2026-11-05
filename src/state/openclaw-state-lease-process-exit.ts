import { registerProcessExitCleanup } from "../infra/process-exit-cleanup.js";
import { loggingState } from "../logging/state.js";

export function registerProcessExitLeaseCleanup(cleanup: () => void): () => void {
  // Exit cleanup runs after CLI output routing is restored (for example after a
  // --json envelope already reached stdout). Lease release reopens the state
  // database and can emit diagnostics, so keep them on stderr to preserve
  // machine-readable stdout for the whole process lifetime.
  return registerProcessExitCleanup(() => {
    const previousForceConsoleToStderr = loggingState.forceConsoleToStderr;
    loggingState.forceConsoleToStderr = true;
    try {
      cleanup();
    } finally {
      loggingState.forceConsoleToStderr = previousForceConsoleToStderr;
    }
  });
}
