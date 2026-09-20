import type { DoctorDatabasePreflight } from "../commands/doctor-database-preflight.js";
import { getFlagValue, hasFlag } from "./argv.js";
import { isDoctorStateMutationInvocation } from "./run-main-policy.js";
export async function withDoctorBootstrapRecovery<T>(
  argv: string[],
  run: () => Promise<T>,
): Promise<T> {
  if (!isDoctorStateMutationInvocation(argv)) {
    return run();
  }
  const { isCurrentRuntimeSupported } = await import("../infra/runtime-guard.js");
  if (!(await isCurrentRuntimeSupported())) {
    return run();
  }
  const [{ withDoctorUpdateRecovery }, { defaultRuntime }] = await Promise.all([
    import("../commands/doctor-update-recovery.js"),
    import("../runtime.js"),
  ]);
  return withDoctorUpdateRecovery(defaultRuntime, run);
}

export async function prepareDoctorBootstrapRecovery<T>(
  argv: string[],
  json: boolean | undefined,
  run: (preflight: DoctorDatabasePreflight | undefined) => Promise<T>,
): Promise<T> {
  // Debug capture can migrate shared state before Commander reaches Doctor.
  // Capture recovery after selectors settle, before any bootstrap writer.
  const { prepareDoctorUpdateRecovery, runWithPreparedDoctorUpdateRecovery } =
    await import("../commands/doctor-update-recovery.js");
  const recoveryOwner = getFlagValue(argv, "--update-recovery-owner");
  const recoveryBackup = getFlagValue(argv, "--update-recovery-backup");
  if (
    recoveryOwner !== undefined &&
    recoveryOwner !== "driver" &&
    recoveryOwner !== "unprotected"
  ) {
    throw new Error("--update-recovery-owner must be driver or unprotected.");
  }
  if (recoveryBackup === null) {
    throw new Error("--update-recovery-backup requires a reference.");
  }
  await prepareDoctorUpdateRecovery({
    updateRecoveryOwner: recoveryOwner,
    updateRecoveryBackup: recoveryBackup,
    repair: hasFlag(argv, "--fix") || hasFlag(argv, "--repair"),
    yes: hasFlag(argv, "--yes"),
    nonInteractive: hasFlag(argv, "--non-interactive"),
  });
  return runWithPreparedDoctorUpdateRecovery(async () => {
    const { guardUpdateDoctorSchemaUpgrade } =
      await import("../commands/doctor-update-schema-guard.js");
    const preflight = await guardUpdateDoctorSchemaUpgrade({
      json,
    });
    return run(preflight);
  });
}
