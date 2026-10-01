import type { DoctorDatabasePreflight } from "../commands/doctor-database-preflight.js";
import type {
  DoctorRepairEvidenceSink,
  ExternallyManagedDoctorRepairReport,
} from "../commands/doctor-externally-managed-repair.js";
import type { DoctorOptions } from "../commands/doctor-prompter.js";
import { resolveConfigPath } from "../config/paths.js";
import {
  captureUpdateDoctorConfigWrites,
  UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH_ENV,
  type DoctorConfigCapture,
  type UpdateDoctorWriteAuthority,
} from "../infra/update-doctor-result.js";
import { withPluginLoadDiagnostics } from "../plugins/load-diagnostics.js";
import type { PluginDiagnostic } from "../plugins/manifest-types.js";
import { withDeferredDebugProxyCapture } from "../proxy-capture/runtime-deferral.js";
import type { RuntimeEnv } from "../runtime.js";
import { UpdateSchemaRefusalError } from "../state/openclaw-update-schema-refusal.js";

export type DoctorHealthFlowResult<TOptions extends DoctorOptions> =
  TOptions["externallyManaged"] extends true ? ExternallyManagedDoctorRepairReport : void;

type RunDoctorHealthFlow = (params: {
  runtime?: RuntimeEnv;
  options: DoctorOptions;
  databasePreflight?: DoctorDatabasePreflight;
  diagnostics: readonly PluginDiagnostic[];
  updateResult?: { resultPath: string; capture: DoctorConfigCapture };
  writeAuthority?: UpdateDoctorWriteAuthority;
  resumeCapture: () => void;
  repairEvidence?: DoctorRepairEvidenceSink;
}) => Promise<void>;

export async function runDoctorHealthEntry<TOptions extends DoctorOptions>(params: {
  runtime?: RuntimeEnv;
  options?: TOptions;
  writeAuthority?: UpdateDoctorWriteAuthority;
  databasePreflight?: DoctorDatabasePreflight;
  run: RunDoctorHealthFlow;
}): Promise<DoctorHealthFlowResult<TOptions>> {
  const options: DoctorOptions = params.options ?? {};
  const externallyManagedRepair = options.externallyManaged
    ? (
        await import("../commands/doctor-externally-managed-repair.js")
      ).createExternallyManagedDoctorRepairEvidence()
    : undefined;
  try {
    await withDeferredDebugProxyCapture(async (resumeCapture) => {
      let databasePreflight = params.databasePreflight;
      if (
        process.env.OPENCLAW_UPDATE_IN_PROGRESS === "1" &&
        !params.writeAuthority?.postCoreSchemaRepair
      ) {
        const { guardUpdateDoctorSchemaUpgrade, rehearseDeferredUpdateDoctorSchema } =
          await import("../commands/doctor-update-schema-guard.js");
        databasePreflight =
          (await guardUpdateDoctorSchemaUpgrade({
            schemas: databasePreflight,
            runtime: params.runtime,
            json: options.json,
          })) ?? databasePreflight;
        if (databasePreflight?.updateSchemaRehearsal) {
          await rehearseDeferredUpdateDoctorSchema(databasePreflight, params.runtime);
          return;
        }
      }
      const resultPath = process.env[UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH_ENV]?.trim();
      return withPluginLoadDiagnostics((diagnostics) => {
        const run = (updateResult?: { resultPath: string; capture: DoctorConfigCapture }) =>
          params.run({
            runtime: params.runtime,
            options,
            databasePreflight,
            diagnostics,
            updateResult,
            writeAuthority: params.writeAuthority,
            resumeCapture,
            repairEvidence: externallyManagedRepair?.sink,
          });
        return resultPath
          ? captureUpdateDoctorConfigWrites(
              resolveConfigPath(),
              (capture) => run({ resultPath, capture }),
              params.writeAuthority,
            )
          : run();
      });
    });
  } catch (error) {
    if (!externallyManagedRepair) {
      throw error;
    }
    if (error instanceof UpdateSchemaRefusalError) {
      throw error;
    }
    const { DoctorStateMigrationRefusalError } =
      await import("../infra/state-migrations.messages.js");
    if (error instanceof DoctorStateMigrationRefusalError) {
      externallyManagedRepair.sink.receipts(error.stepReceipts);
    } else {
      externallyManagedRepair.fail(error);
    }
  }
  // SAFETY: externally managed mode always creates the report; every other mode returns void.
  return externallyManagedRepair?.finish() as DoctorHealthFlowResult<TOptions>;
}
