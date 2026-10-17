import { randomUUID } from "node:crypto";
import { resolveOpenClawCliInvocation } from "../../cli-invocation.mjs";
import { scrubDoctorErrorMessage } from "../flows/doctor-error-message.js";
import { resolveOpenClawPackageRoot } from "../infra/openclaw-root.js";
import {
  consumeUpdatePostInstallDoctorResult,
  createUpdatePostInstallDoctorResultPath,
  UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH_ENV,
  writeUpdatePostInstallDoctorResult,
  type UpdatePostInstallDoctorResult,
} from "../infra/update-doctor-result.js";
import type { UpdateStepResult } from "../infra/update-step-result.js";
import { resolveCommandProcessSignal } from "../process/exec-spawn.js";
import { defaultRuntime } from "../runtime.js";
import {
  installCliDoctorSignalExitHandlers,
  registerSignalExitBarrier,
} from "./signal-exit-barrier.js";
import { runUpdateDoctorProcess } from "./update-cli/update-command-doctor-child.js";

/** The native stdout adapter retains the existing file IPC and child settlement owner. */
export async function tryRunDoctorResultBridge(argv: string[]): Promise<boolean> {
  if (process.env[UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH_ENV]?.trim() !== "-") {
    return false;
  }
  const root = await resolveOpenClawPackageRoot({
    moduleUrl: import.meta.url,
    argv1: argv[1],
    cwd: process.cwd(),
  });
  if (!root || !argv[1]) {
    throw new Error("Doctor process custody requires its installed CLI root.");
  }
  const resultPath = createUpdatePostInstallDoctorResultPath();
  const controller = new AbortController();
  const callerSignal = resolveCommandProcessSignal();
  const signal = callerSignal
    ? AbortSignal.any([callerSignal, controller.signal])
    : controller.signal;
  let worker: ReturnType<typeof runUpdateDoctorProcess> | undefined;
  let settlement: UpdateStepResult | undefined;
  const releaseBarrier = registerSignalExitBarrier(async () => {
    controller.abort();
    await worker?.catch(() => {});
  });
  installCliDoctorSignalExitHandlers();
  let exitCode = 1;
  let failed = false;
  try {
    const invocation = resolveOpenClawCliInvocation({ entryPath: argv[1], args: argv.slice(2) });
    worker = runUpdateDoctorProcess(
      { root, runId: randomUUID(), onProcessSettlement: (step) => (settlement = step) },
      [invocation.command, ...invocation.args],
      {
        cwd: process.cwd(),
        baseEnv: process.env,
        env: { [UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH_ENV]: resultPath },
        signal,
        maxOutputBytes: 4 * 1024 * 1024,
        terminateOnOutputLimit: true,
        terminateOnOutputError: true,
        onOutputChunk: (chunk, stream) => process[stream].write(chunk),
      },
    );
    try {
      const response = await worker;
      exitCode = response.code ?? 1;
    } catch (error) {
      failed = true;
      defaultRuntime.error(scrubDoctorErrorMessage(error));
    }
    const captured = await consumeUpdatePostInstallDoctorResult(resultPath);
    const failureFacts = [...(captured?.failureFacts ?? []), ...(settlement?.failureFacts ?? [])];
    const result: UpdatePostInstallDoctorResult = {
      ...(captured ?? { status: "error" }),
      ...(failed || !captured || settlement?.exitCode === 1 ? { status: "error" as const } : {}),
      ...(failureFacts.length ? { failureFacts } : {}),
      ...(settlement?.advisory
        ? { warnings: [...(captured?.warnings ?? []), settlement.advisory.message] }
        : {}),
    };
    const completedRepair =
      !failed &&
      captured &&
      (captured.status === "ok" || captured.status === "advisory") &&
      !captured.maintenanceRefusal &&
      !captured.configWriteRefusal &&
      !failureFacts.length &&
      settlement?.exitCode === 0 &&
      settlement.advisory?.kind === "recoverable-maintenance";
    // A missing classified result must remain missing at the native boundary;
    // process settlement alone cannot certify that required Doctor work finished.
    if (captured) {
      await writeUpdatePostInstallDoctorResult({ resultPath: "-", result });
    }
    process.exitCode =
      result.status === "error"
        ? 1
        : completedRepair
          ? result.status === "advisory"
            ? 86
            : 0
          : exitCode;
    return true;
  } finally {
    releaseBarrier();
  }
}
