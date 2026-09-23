import { withConsoleLogsRoutedToStderrForJson } from "../cli/json-output-mode.js";
import { exitCliAfterOutput, runCliWithExitFinalization } from "../cli/one-shot-exit.js";
import { withCliCommandCleanup, withCliProcessScope } from "../cli/runtime-cleanup-scope.js";
import { closeCliResources, runCliDisposer } from "../cli/runtime-cleanup.js";
import { scrubDoctorErrorMessage } from "../flows/doctor-error-message.js";
import { resolveUpdateRehearsalRoot } from "../infra/update-rehearsal-paths.js";
import { enableConsoleCapture } from "../logging/console.js";
import { defaultRuntime } from "../runtime.js";
import { DoctorLintCliOptionsSchema } from "./doctor-lint-options.js";

async function runDoctorLintWorker(): Promise<void> {
  if (!resolveUpdateRehearsalRoot(process.env)) {
    throw new Error("Doctor lint worker requires an isolated update rehearsal.");
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > 1024 * 1024) {
      throw new Error("Doctor lint worker input exceeded its limit.");
    }
    chunks.push(buffer);
  }
  const opts = DoctorLintCliOptionsSchema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
  if (opts.json !== true) {
    throw new Error("Doctor lint worker requires JSON output.");
  }
  enableConsoleCapture();
  await withCliProcessScope(() =>
    withCliCommandCleanup(false, async (cleanup) => {
      let exitCode: number;
      try {
        const { runDoctorLintCliInProcess } = await import("./doctor-lint.js");
        exitCode = await runDoctorLintCliInProcess(defaultRuntime, opts, true);
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

void withConsoleLogsRoutedToStderrForJson(
  process.argv,
  () =>
    runCliWithExitFinalization({
      run: runDoctorLintWorker,
      onError: (error) => {
        process.stderr.write(`Doctor lint worker failed: ${scrubDoctorErrorMessage(error)}\n`);
        process.exitCode = 2;
      },
    }),
  { machineOutput: true, retainRoutingUntilProcessExit: true },
);
