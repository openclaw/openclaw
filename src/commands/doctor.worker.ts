import { exitCliAfterOutput, runCliWithExitFinalization } from "../cli/one-shot-exit.js";
import { withCliCommandCleanup, withCliProcessScope } from "../cli/runtime-cleanup-scope.js";
import {
  closeCliResources,
  runCliDisposer,
  waitForPendingCliDisposers,
} from "../cli/runtime-cleanup.js";
import { scrubDoctorErrorMessage } from "../flows/doctor-error-message.js";
import { enableConsoleCapture } from "../logging/console.js";
import { defaultRuntime } from "../runtime.js";

async function runDoctorWorker(): Promise<void> {
  enableConsoleCapture();
  await withCliProcessScope(() =>
    withCliCommandCleanup(false, async (cleanup) => {
      let exitCode: number;
      try {
        // Hosted diagnosis has no repair approval; non-interactive Doctor still migrates state.
        const { runDoctorLintCli } = await import("./doctor-lint.js");
        exitCode = await runDoctorLintCli(defaultRuntime, {});
      } finally {
        await closeCliResources(cleanup);
        const resources = cleanup?.pluginResources;
        if (resources) {
          await runCliDisposer("plugin-registration-resources", () => resources.release());
        }
      }
      exitCliAfterOutput(defaultRuntime, exitCode);
    }),
  );
}

void runCliWithExitFinalization({
  run: runDoctorWorker,
  finalize: waitForPendingCliDisposers,
  onError(error) {
    defaultRuntime.error(`Doctor failed: ${scrubDoctorErrorMessage(error)}`);
    process.exitCode = 1;
  },
});
