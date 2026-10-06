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
      try {
        const { doctorCommand } = await import("./doctor.js");
        await doctorCommand(defaultRuntime, { nonInteractive: true });
      } finally {
        await closeCliResources(cleanup);
        const resources = cleanup?.pluginResources;
        if (resources) {
          await runCliDisposer("plugin-registration-resources", () => resources.release());
        }
      }
      exitCliAfterOutput(defaultRuntime, 0);
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
