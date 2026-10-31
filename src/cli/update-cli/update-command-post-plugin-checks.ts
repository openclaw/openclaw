import { UPDATE_POST_CORE_CONVERGENCE_ENV } from "../../commands/doctor/shared/update-phase.js";
import { defaultRuntime, writeRuntimeJson } from "../../runtime.js";
import { withConsoleLogsRoutedToStderrForJson } from "../json-output-mode.js";
import { runCliWithExitFinalization } from "../one-shot-exit.js";
import { withCliCommandCleanup, withCliProcessScope } from "../runtime-cleanup-scope.js";
import { closeCliResources, runCliDisposer } from "../runtime-cleanup.js";

export async function runPostPluginChecks(params: {
  skipConfigValidation: boolean;
  includeOptionalInspections: boolean;
}): Promise<void> {
  process.env.OPENCLAW_UPDATE_IN_PROGRESS = "0";
  delete process.env[UPDATE_POST_CORE_CONVERGENCE_ENV];
  await withConsoleLogsRoutedToStderrForJson(
    process.argv,
    () =>
      runCliWithExitFinalization({
        onError: (error) => {
          throw error;
        },
        run: () =>
          withCliProcessScope(() =>
            withCliCommandCleanup(false, async (cleanup) => {
              try {
                if (params.skipConfigValidation) {
                  writeRuntimeJson(defaultRuntime, { valid: true }, 0);
                } else {
                  const { runConfigValidationCli } = await import("../config-cli-validation.js");
                  await runConfigValidationCli({ json: true });
                }
                const commandStartedAtMs = Date.now();
                process.env.OPENCLAW_UPDATE_IN_PROGRESS = "1";
                process.env[UPDATE_POST_CORE_CONVERGENCE_ENV] = "1";
                const { preparePostgresPoolForUpdate } =
                  await import("../../infra/postgres-sync/pool.js");
                await preparePostgresPoolForUpdate("openclaw doctor --fix");
                const { runDoctorLintCliInProcess } =
                  await import("../../commands/doctor-lint-runner.js");
                process.exitCode = await runDoctorLintCliInProcess(
                  defaultRuntime,
                  {
                    json: true,
                    severityMin: params.includeOptionalInspections ? "info" : "error",
                    ...(params.includeOptionalInspections ? { includeAllChecks: true } : {}),
                  },
                  { commandStartedAtMs },
                );
              } finally {
                await closeCliResources(cleanup);
                const resources = cleanup?.pluginResources;
                if (resources) {
                  await runCliDisposer("plugin-registration-resources", () => resources.release());
                }
              }
            }),
          ),
      }),
    { machineOutput: true, retainRoutingUntilProcessExit: true },
  );
}
