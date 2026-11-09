import { exitCliAfterOutput, runCliWithExitFinalization } from "../cli/one-shot-exit.js";
import { scrubDoctorErrorMessage } from "../flows/doctor-error-message.js";
import { enableConsoleCapture } from "../logging/console.js";
import { defaultRuntime } from "../runtime.js";

async function runDoctorWorker(): Promise<void> {
  enableConsoleCapture();
  // These checks admit no persistent resources; the parent owns helper-process reaping.
  const { runHostedDoctorLint } = await import("./doctor-hosted.js");
  exitCliAfterOutput(defaultRuntime, await runHostedDoctorLint(defaultRuntime));
}

void runCliWithExitFinalization({
  run: runDoctorWorker,
  onError(error) {
    defaultRuntime.error(`Doctor failed: ${scrubDoctorErrorMessage(error)}`);
    process.exitCode = 1;
  },
});
