import { formatCliCommand } from "../cli/command-format.js";
import { formatErrorMessage } from "../infra/errors.js";
import {
  assertLegacyGatewayStoppedForMaintenance,
  readLegacyGatewayLockIdentity,
} from "../infra/gateway-lock-legacy.js";
import { inspectGatewayLockRecovery, recoverGatewayLock } from "../infra/gateway-lock-recovery.js";
import { GatewayLockError } from "../infra/gateway-lock.js";
import type { RuntimeEnv } from "../runtime.js";
import type { DoctorOptions } from "./doctor-prompter.js";
import { resolveDoctorRepairMode } from "./doctor-repair-mode.js";

export type DoctorLegacyLockRecoveryParams = {
  env: NodeJS.ProcessEnv;
  options: DoctorOptions;
  runtime: RuntimeEnv;
  signal?: AbortSignal;
};

/**
 * A legacy-lock recovery offer needs an operator who can answer it: never
 * during an update, never for machine-readable output, never without a TTY.
 */
export function canOfferDoctorLegacyLockRecovery(
  options: DoctorOptions,
  env: NodeJS.ProcessEnv,
): boolean {
  if (options.json === true) {
    return false;
  }
  const mode = resolveDoctorRepairMode(options, env);
  return mode.canPrompt && !mode.updateInProgress;
}

/**
 * After a legacy-lock admission refusal, offer explicit recovery when lock
 * inspection covers the refusing record. Returns true when admission should
 * be retried: the record was recovered, or it vanished on re-read. A live
 * holder still refuses inside `recoverGatewayLock`.
 */
export async function maybeRecoverLegacyGatewayLockForDoctor(
  params: DoctorLegacyLockRecoveryParams,
): Promise<boolean> {
  if (!canOfferDoctorLegacyLockRecovery(params.options, params.env)) {
    return false;
  }
  const owner = await readLegacyGatewayLockIdentity(params.env).catch(() => undefined);
  if (!owner) {
    // Gone, or unreadable in a new way; the admission re-check reports the truth.
    return true;
  }
  const inspection = await inspectGatewayLockRecovery({ env: params.env });
  const covered = inspection.files.some(
    ({ path, observed }) => observed !== null && path === owner.path,
  );
  if (!covered || !inspection.present) {
    // A record outside inspection keeps the refusal and its printed remedy.
    return false;
  }
  params.runtime.log(
    `Doctor could not enter maintenance. Legacy Gateway lock ${owner.path} still has a live or unverified owner (PID ${owner.pid}).`,
  );
  for (const holder of inspection.holders) {
    params.runtime.log(holder);
  }
  const command = formatCliCommand(
    `openclaw gateway recover-lock --confirm ${inspection.confirmation}`,
  );
  params.runtime.log(
    "Stop the recorded holder through its service manager or container first. " +
      "If you have confirmed it stopped, recover exactly these unchanged records now, or run:",
  );
  params.runtime.log(command);
  const { createDoctorPrompter } = await import("./doctor-prompter.js");
  const confirmed = await createDoctorPrompter({
    runtime: params.runtime,
    options: params.options,
    signal: params.signal,
  }).confirmRuntimeRepair({
    message:
      "Recover the listed Gateway lock records so Doctor maintenance can proceed? " +
      "Confirm only if each recorded holder has stopped on this host and in every container sharing the lock directory.",
    requiresInteractiveConfirmation: true,
  });
  if (!confirmed) {
    return false;
  }
  try {
    await recoverGatewayLock({ confirmation: inspection.confirmation });
  } catch (error) {
    params.runtime.error(`Gateway lock recovery failed: ${formatErrorMessage(error)}`);
    return false;
  }
  params.runtime.log("Gateway lock recovery completed.");
  return true;
}

/**
 * Maintenance admission with one interactive recovery attempt: on a legacy-lock
 * refusal, an operator who can answer is offered explicit recovery of a covered
 * record, then admission is re-checked once. Anything else rethrows unchanged.
 */
export async function assertLegacyGatewayStoppedWithDoctorRecovery(
  params: DoctorLegacyLockRecoveryParams,
): Promise<void> {
  try {
    await assertLegacyGatewayStoppedForMaintenance(params.env);
  } catch (error) {
    // The refusal remedy leaves the record in place; an interactive operator
    // can explicitly recover a covered lock instead of retrying the refusal.
    const recovered =
      error instanceof GatewayLockError && (await maybeRecoverLegacyGatewayLockForDoctor(params));
    if (!recovered) {
      throw error;
    }
    await assertLegacyGatewayStoppedForMaintenance(params.env);
  }
}
