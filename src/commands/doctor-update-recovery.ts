import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs/promises";
import path from "node:path";
import { hashConfigRaw } from "../config/io.read-helpers.js";
import { resolveConfigPath } from "../config/paths.js";
import { withConfigFileWriteCapture } from "../config/write-capture.js";
import { hasErrnoCode } from "../infra/errno.js";
import { formatErrorMessage, toErrorObject } from "../infra/errors.js";
import { UPDATE_RUN_ID_ENV } from "../infra/update-control-plane-sentinel.js";
import {
  consumeUpdatePostInstallDoctorResult,
  UPDATE_POST_INSTALL_DOCTOR_ADVISORY_EXIT_CODE,
  UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH_ENV,
  writeUpdatePostInstallDoctorResult,
} from "../infra/update-doctor-result.js";
import type { UpdateRecoveryBackupRef } from "../infra/update-recovery-backup-contract.js";
import {
  inspectUpdateRunAbandonment,
  recordedUpdateRunDrivers,
} from "../infra/update-run-activity.js";
import {
  inspectUpdateRunDriver,
  readUpdateRunDriver,
  sameUpdateRunDriver,
  type UpdateRunDriver,
} from "../infra/update-run-driver.js";
import type { UpdateRunRecord } from "../infra/update-run-record.js";
import type { UpdateRecoveryFence } from "../infra/update-run-recovery.js";
import { ExitError, type RuntimeEnv } from "../runtime.js";
import type { beginDoctorMaintenance } from "./doctor-maintenance.js";
import type { DoctorOptions } from "./doctor-prompter.js";

type DoctorRecoveryScope = {
  runtime: RuntimeEnv;
  prepared: boolean;
  protected: boolean;
  storesClosed?: boolean;
  backup?: UpdateRecoveryBackupRef;
  backupRunId?: string;
  resolved?: UpdateRecoveryBackupRef;
  reference?: UpdateRecoveryBackupRef;
  assertRecoveryClaim?: () => void;
  revalidatePendingRecovery?: () => Promise<void>;
  maintenance?: Awaited<ReturnType<typeof beginDoctorMaintenance>>;
};

type DoctorRunOutcome<T> = { ok: true; value: T } | { ok: false; error: unknown };

const doctorRecovery = new AsyncLocalStorage<DoctorRecoveryScope>();

function isCompletedDoctorExit(error: unknown): boolean {
  return (
    error instanceof ExitError &&
    (error.code === 0 || error.code === UPDATE_POST_INSTALL_DOCTOR_ADVISORY_EXIT_CODE)
  );
}

/** The CLI scope includes bootstrap writes; direct Doctor callers reuse that owner. */
export async function withDoctorUpdateRecovery<T>(
  runtime: RuntimeEnv,
  run: () => Promise<T>,
): Promise<T> {
  if (doctorRecovery.getStore()) {
    return run();
  }
  const scope: DoctorRecoveryScope = { runtime, prepared: false, protected: false };
  return withConfigFileWriteCapture(() =>
    doctorRecovery.run(scope, async () => {
      let outcome: DoctorRunOutcome<T>;
      try {
        outcome = { ok: true, value: await run() };
      } catch (error) {
        outcome = { ok: false, error };
      }
      const failure =
        !outcome.ok && !isCompletedDoctorExit(outcome.error) ? { error: outcome.error } : undefined;
      const settlementErrors: unknown[] = [];
      try {
        if (scope.reference) {
          const { persistUpdateRecoveryConfigWrites } =
            await import("../infra/update-recovery-config-writes.js");
          try {
            await persistUpdateRecoveryConfigWrites(scope.reference, {
              assertOwned: () => assertDoctorRecoveryCurrent(scope),
            });
          } catch (error) {
            if (scope.backup) {
              await restoreDoctorBackup(scope, scope.backup, error);
            }
            throw new AggregateError(
              [error],
              `Doctor could not record configuration write ownership for ${scope.reference.manifestPath}. Run \`npx openclaw@latest doctor --fix\` to recover.`,
              { cause: error },
            );
          }
        }
        if (scope.backup) {
          if (failure) {
            await restoreDoctorBackup(scope, scope.backup);
          } else {
            try {
              await scope.maintenance?.closeStores();
              scope.storesClosed = true;
            } catch (error) {
              await restoreDoctorBackup(scope, scope.backup, error);
              throw error;
            }
            try {
              const { recordUpdateRunRecoveryCapture } =
                await import("../infra/update-run-ledger.js");
              if (!scope.backupRunId) {
                throw new Error("Doctor capture run identity is missing");
              }
              recordUpdateRunRecoveryCapture(
                scope.backupRunId,
                {
                  manifestSha256: scope.backup.manifestSha256,
                  doctorCompleted: true,
                },
                () => assertDoctorRecoveryCurrent(scope),
              );
            } catch (error) {
              assertDoctorRecoveryCurrent(scope);
              scope.runtime.error(
                `Warning: Doctor completed, but its capture outcome could not be recorded at ${scope.backup.manifestPath}: ${String(error)}. Inspect with openclaw update status --json; run npx openclaw@latest doctor --fix.`,
              );
            }
          }
        }
      } catch (error) {
        settlementErrors.push(error);
      }
      scope.protected = false;
      try {
        await scope.maintenance?.release();
      } catch (error) {
        if (scope.storesClosed) {
          scope.runtime.error(`Warning: Doctor maintenance cleanup failed: ${String(error)}`);
        } else {
          settlementErrors.push(error);
        }
      }
      if (settlementErrors.length > 0) {
        if (!failure && settlementErrors.length === 1) {
          throw toErrorObject(settlementErrors[0], "Doctor recovery settlement failed");
        }
        throw new AggregateError(
          [...(failure ? [failure.error] : []), ...settlementErrors],
          settlementErrors.map(formatErrorMessage).join("; "),
          { cause: failure ? failure.error : settlementErrors[0] },
        );
      }
      if (scope.resolved && !failure && settlementErrors.length === 0) {
        try {
          await retireDoctorResolvedCapture(scope.resolved, scope.runtime);
        } catch (error) {
          scope.runtime.error(
            `Warning: Doctor completed; capture cleanup requires inspection at ${scope.resolved.manifestPath}: ${String(error)}. Run openclaw update status --json.`,
          );
        }
      }
      if (!outcome.ok) {
        throw toErrorObject(outcome.error, "Doctor failed");
      }
      return outcome.value;
    }),
  );
}

function assertDoctorRecoveryCurrent(scope: DoctorRecoveryScope): void {
  if (!scope.maintenance) {
    throw new Error("Doctor recovery lost maintenance ownership.");
  }
  scope.maintenance.assertCurrent();
  scope.assertRecoveryClaim?.();
}

async function restoreDoctorBackup(
  scope: DoctorRecoveryScope,
  backup: UpdateRecoveryBackupRef,
  failure?: unknown,
) {
  const { restoreUpdateRecoveryBackup, writeUpdateRecoveryBackupOutcome } =
    await import("../infra/update-recovery-backup.js");
  const { recordUpdateRunRecoveryCapture, recordUpdateRunStep } =
    await import("../infra/update-run-ledger.js");
  const maintenance = scope.maintenance;
  if (!maintenance) {
    throw new Error("Doctor recovery lost maintenance ownership.");
  }
  const runId = scope.backupRunId;
  if (!runId) {
    throw new Error("Doctor recovery lost its verified capture run identity.");
  }
  const authority = { assertOwned: () => assertDoctorRecoveryCurrent(scope) };
  if (scope.revalidatePendingRecovery) {
    await maintenance.closeStores();
    scope.storesClosed = true;
    // Refused admission must not overwrite a reconciled terminal backup outcome.
    await scope.revalidatePendingRecovery();
  }
  try {
    // Lease release can write shared state; finish it before restoring the old schema.
    if (!scope.storesClosed) {
      await maintenance.closeStores();
    }
    scope.storesClosed = true;
    await restoreUpdateRecoveryBackup(backup, authority);
  } catch (error) {
    const errors = failure === undefined ? [error] : [failure, error];
    try {
      await writeUpdateRecoveryBackupOutcome(
        backup,
        {
          status: "restore-failed",
          error: String(error),
        },
        authority,
      );
    } catch (recordingError) {
      errors.push(recordingError);
    }
    throw new AggregateError(
      errors,
      `Doctor could not restore the update backup at ${backup.manifestPath}. Keep the Gateway stopped and run \`npx openclaw@latest doctor --fix\` to retry recovery.`,
      { cause: error },
    );
  }
  try {
    recordUpdateRunRecoveryCapture(
      runId,
      {
        manifestSha256: backup.manifestSha256,
        restored: true,
      },
      authority.assertOwned,
    );
  } catch (error) {
    assertDoctorRecoveryCurrent(scope);
    scope.runtime.error(
      `Warning: State was restored, but its recovery receipt could not be recorded at ${backup.manifestPath}: ${String(error)}`,
    );
  }
  try {
    // The 9.2 writer strips unknown origin fields but preserves this completed step.
    authority.assertOwned();
    recordUpdateRunStep(runId, {
      step: "state rollback",
      status: "completed",
      endedAtMs: Date.now(),
    });
  } catch (error) {
    assertDoctorRecoveryCurrent(scope);
    scope.runtime.error(
      `Warning: State was restored, but its compatibility recovery step could not be recorded at ${backup.manifestPath}: ${String(error)}`,
    );
  }
  if (process.env.OPENCLAW_UPDATE_IN_PROGRESS === "1") {
    try {
      await recordRestoredDoctorConfig();
    } catch (error) {
      assertDoctorRecoveryCurrent(scope);
      scope.runtime.error(
        `Warning: State was restored, but updater configuration reporting failed; package rollback confirmation may be blocked. Backup retained at ${backup.manifestPath}. After the updater exits, run \`npx openclaw@latest doctor --fix\`. ${String(error)}`,
      );
    }
  }
  try {
    await writeUpdateRecoveryBackupOutcome(backup, { status: "restored" }, authority);
  } catch (error) {
    assertDoctorRecoveryCurrent(scope);
    scope.runtime.error(
      `Warning: State was restored, but its backup outcome could not be recorded at ${backup.manifestPath}: ${String(error)}`,
    );
  }
  scope.runtime.error(
    `Restored state from the update backup retained at ${backup.manifestPath}. The older updater may leave the Gateway stopped; after it finishes, run \`openclaw gateway start\`. To complete the update repair, run \`npx openclaw@latest doctor --fix\`.`,
  );
}

async function recordRestoredDoctorConfig(): Promise<void> {
  const resultPath = process.env[UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH_ENV];
  if (!resultPath) {
    return;
  }
  const result = await consumeUpdatePostInstallDoctorResult(resultPath);
  const raw = await fs.readFile(resolveConfigPath(), "utf8").catch((error: unknown) => {
    if (hasErrnoCode(error, "ENOENT")) {
      return null;
    }
    throw error;
  });
  const hash = hashConfigRaw(raw);
  // The driving updater compares its input with these bytes before package rollback.
  await writeUpdatePostInstallDoctorResult({
    resultPath,
    result: {
      status: "error",
      configHash: hash,
      configInputHash: hash,
      ...(result?.warnings ? { warnings: result.warnings } : {}),
    },
  });
}

async function activeUpdateRuns() {
  const { listUpdateRunsAsync } = await import("../infra/update-run-reader.js");
  const runs = await listUpdateRunsAsync({ active: true, limit: 100 });
  if (runs.length === 100) {
    throw new Error(
      "Doctor cannot verify every active update owner; resolve update history first.",
    );
  }
  return runs;
}

function hasActiveDoctorStep(run: UpdateRunRecord | undefined): run is UpdateRunRecord {
  return (
    run?.status === "running" &&
    run.steps.some((step) => step.step === "openclaw doctor" && step.status === "in_progress")
  );
}

function assertRecoveryDriversExited(drivers: readonly UpdateRunDriver[]): void {
  if (drivers.some((driver) => inspectUpdateRunDriver(driver) !== "dead")) {
    throw new Error(
      "Update recovery still has a live or unobservable owner. Let the update and its Doctor exit, then run `npx openclaw@latest doctor --fix` again.",
    );
  }
}

async function assertPendingRecoveryOffline(): Promise<void> {
  const { readActiveGatewayLockIdentity } = await import("../infra/gateway-lock.js");
  if (await readActiveGatewayLockIdentity({ requireInspection: true })) {
    throw new Error(
      "Doctor will not restore an update backup while the Gateway is running. Stop it through its service owner, then run `npx openclaw@latest doctor --fix`.",
    );
  }
}

/** Called after profile/dotenv selection and before any CLI bootstrap state writer. */
export async function prepareDoctorUpdateRecovery(options: DoctorOptions = {}): Promise<void> {
  const supplied = options.updateRecoveryBackup;
  const marked = options.updateRecoveryOwner !== undefined || supplied !== undefined;
  if (
    marked &&
    (options.updateRecoveryOwner === "unprotected"
      ? supplied !== undefined
      : options.updateRecoveryOwner !== "driver" || !supplied?.trim())
  ) {
    throw new Error(
      "Doctor update recovery requires both the driver owner and a backup reference.",
    );
  }
  const updating = process.env.OPENCLAW_UPDATE_IN_PROGRESS === "1";
  if (marked && !updating) {
    throw new Error("Doctor update recovery options require an update invocation.");
  }
  const scope = doctorRecovery.getStore();
  if (!scope || scope.prepared) {
    return;
  }
  scope.prepared = true;
  if (options.updateRecoveryOwner === "unprotected") {
    const { readUnprotectedGatewayUpdateParent } =
      await import("../infra/update-run-recovery-admission.js");
    const { UNPROTECTED_GATEWAY_UPDATE_ADVISORY } = await import("../infra/update-run-record.js");
    const parent = readUnprotectedGatewayUpdateParent();
    if (!parent) {
      throw new Error("Unprotected Doctor requires an explicitly declared Gateway update parent.");
    }
    parent.assertCurrent();
    scope.assertRecoveryClaim = parent.assertCurrent;
    scope.runtime.error(UNPROTECTED_GATEWAY_UPDATE_ADVISORY);
    return;
  }
  if (!updating && options.repair !== true && options.yes !== true) {
    try {
      const { inspectUpdateRecoveryBackups } = await import("../infra/update-recovery-backup.js");
      const inspections = await inspectUpdateRecoveryBackups();
      for (const inspection of inspections) {
        scope.runtime.error(inspection.message);
      }
      if (inspections.length > 0) {
        scope.runtime.error(
          "Inspect retained update captures with `openclaw update status --json`; resolve them with `npx openclaw@latest doctor --fix`.",
        );
      }
    } catch (error) {
      scope.runtime.error(
        `Warning: Retained update captures could not be inspected: ${formatErrorMessage(error)}. Run \`openclaw update status --json\`; resolve with \`npx openclaw@latest doctor --fix\`.`,
      );
    }
    return;
  }
  if (updating) {
    // A backup cannot supply publication metadata required by the old driver's live reader.
    const { guardUpdateDoctorSchemaUpgrade } = await import("./doctor-update-schema-guard.js");
    await guardUpdateDoctorSchemaUpgrade({
      runtime: scope.runtime,
      json: options.json,
      statePublicationOnly: true,
    });
  }
  const backup = await import("../infra/update-recovery-backup.js");
  if (!updating) {
    for (const retirement of await backup.inspectUpdateRecoveryRetirements()) {
      await retireDoctorResolvedCapture(retirement.ref, scope.runtime, retirement);
    }
  }
  const pending = !updating
    ? await backup.findPendingUpdateRecoveryBackup({
        warn: (message) => scope.runtime.error(message),
      })
    : null;
  if (!updating && !pending) {
    const resolved = (await backup.inspectUpdateRecoveryBackups()).find(
      (entry) => entry.status === "stale",
    );
    if (resolved) {
      scope.resolved = resolved.ref;
    }
    return;
  }
  if (pending) {
    const manifest = await backup.verifyUpdateRecoveryBackup(pending);
    scope.backupRunId = manifest.runId;
    const runs = await activeUpdateRuns();
    const drivers = [
      manifest.creator,
      ...manifest.drivers,
      ...runs.flatMap(recordedUpdateRunDrivers),
    ];
    if (runs.some((run) => !inspectUpdateRunAbandonment(run, { explicit: true }))) {
      throw new Error(
        "An update has not been proven abandoned. Let its owner finish or inspect it with `openclaw update repair` before retrying `npx openclaw@latest doctor --fix`.",
      );
    }
    scope.assertRecoveryClaim = () => assertRecoveryDriversExited(drivers);
    scope.assertRecoveryClaim();
    await assertPendingRecoveryOffline();
  }
  const { assertConfigWriteAllowedInCurrentMode } = await import("../config/config-write-guard.js");
  assertConfigWriteAllowedInCurrentMode();
  const [{ resolveOpenClawPackageRoot }, { beginDoctorMaintenance }] = await Promise.all([
    import("../infra/openclaw-root.js"),
    import("./doctor-maintenance.js"),
  ]);
  const root = await resolveOpenClawPackageRoot({
    moduleUrl: import.meta.url,
    argv1: process.argv[1],
    cwd: process.cwd(),
  });
  if (!root) {
    throw new Error("Doctor cannot identify its installation for update recovery.");
  }
  scope.maintenance = await beginDoctorMaintenance({
    options: { ...options, repair: true },
    root: pending ? null : root,
    runtime: scope.runtime,
  });
  const maintenance = scope.maintenance;
  if (!maintenance) {
    throw new Error("Doctor could not acquire update recovery maintenance ownership.");
  }
  if (pending) {
    const { assertUpdateRecoveryBackupAdmission } =
      await import("../infra/update-run-recovery-admission.js");
    await assertUpdateRecoveryBackupAdmission({ env: process.env }, () =>
      assertDoctorRecoveryCurrent(scope),
    );
    await assertPendingRecoveryOffline();
    scope.revalidatePendingRecovery = async () => {
      const selected = await backup.findPendingUpdateRecoveryBackup({
        warn: (message) => scope.runtime.error(message),
      });
      if (
        selected?.directory !== pending.directory ||
        selected.manifestSha256 !== pending.manifestSha256
      ) {
        throw new Error(
          `Update recovery set ${pending.manifestPath} is no longer eligible. Inspect with \`openclaw update status --json\`.`,
        );
      }
      assertDoctorRecoveryCurrent(scope);
      await assertPendingRecoveryOffline();
      assertDoctorRecoveryCurrent(scope);
    };
    await restoreDoctorBackup(scope, pending);
    scope.resolved = pending;
    // Normal repair owns the restored state; only successful explicit repair permits retirement.
    return;
  }
  let reference: UpdateRecoveryBackupRef;
  if (supplied !== undefined) {
    reference = backup.readUpdateRecoveryBackupRef(supplied);
  } else {
    const inheritedRunId = process.env[UPDATE_RUN_ID_ENV]?.trim();
    // Shipped 9.2 records this step before spawning Doctor but has no driver identities.
    const matchesDoctor = (run: UpdateRunRecord) =>
      hasActiveDoctorStep(run) && (!inheritedRunId || run.runId === inheritedRunId);
    const candidates = (await activeUpdateRuns()).filter(matchesDoctor);
    const run = candidates[0];
    if (!run || candidates.length !== 1) {
      throw new Error(
        "Doctor cannot identify one admitted update run with an active Doctor step for its capture. Inspect with openclaw update status --json; run npx openclaw@latest doctor --fix after resolving ownership.",
      );
    }
    const parent = readUpdateRunDriver(process.ppid);
    if (!parent) {
      throw new Error(
        "Doctor cannot identify its parent updater process for recovery. Inspect with openclaw update status --json; run npx openclaw@latest doctor --fix after resolving ownership.",
      );
    }
    const { listUpdateRuns } = await import("../infra/update-run-ledger.js");
    scope.assertRecoveryClaim = () => {
      const active = listUpdateRuns({ active: true, limit: 100 });
      const matching = active.filter(matchesDoctor);
      if (
        process.ppid !== parent.pid ||
        active.length === 100 ||
        matching.length !== 1 ||
        matching[0]?.runId !== run.runId
      ) {
        throw new Error(
          "Doctor's admitted update run or parent changed during recovery. Inspect with openclaw update status --json; run npx openclaw@latest doctor --fix after resolving ownership.",
        );
      }
    };
    const drivers = recordedUpdateRunDrivers(run);
    if (!drivers.some((driver) => sameUpdateRunDriver(driver, parent))) {
      drivers.push(parent);
    }
    reference = await backup.createUpdateRecoveryBackup({
      runId: run.runId,
      installRoot: root,
      drivers,
      assertOwned: () => assertDoctorRecoveryCurrent(scope),
    });
  }
  const capturedManifest = await backup.verifyUpdateRecoveryBackup(reference);
  assertDoctorRecoveryCurrent(scope);
  scope.reference = reference;
  if (supplied === undefined) {
    await backup.writeUpdateRecoveryBackupOutcome(
      reference,
      { status: "pending" },
      {
        assertOwned: () => assertDoctorRecoveryCurrent(scope),
      },
    );
    scope.backup = reference;
    scope.backupRunId = capturedManifest.runId;
  }
  scope.protected = true;
}

export function hasVerifiedDoctorUpdateRecovery(): boolean {
  const scope = doctorRecovery.getStore();
  if (!scope?.protected) {
    return false;
  }
  assertDoctorRecoveryCurrent(scope);
  return true;
}

/** Process exit must unwind the recovery owner before terminating the Doctor child. */
export function doctorUpdateRecoveryRuntime(runtime: RuntimeEnv): RuntimeEnv {
  const scope = doctorRecovery.getStore();
  scope?.assertRecoveryClaim?.();
  if (!scope?.maintenance) {
    return runtime;
  }
  return {
    ...runtime,
    exit(code) {
      throw new ExitError(code);
    },
  };
}

function hasVerifiedCompletedUpdate(run: UpdateRunRecord | undefined): run is UpdateRunRecord {
  if (!run) {
    return false;
  }
  const completed = (names: string[]) =>
    run.steps.some((step) => names.includes(step.step) && step.status === "completed");
  const health = run.verification;
  return (
    run.status === "succeeded" &&
    run.finishedAtMs !== null &&
    run.confirmedAtMs !== null &&
    Boolean(run.after.version) &&
    health.runningVersion === run.after.version &&
    (!run.after.buildId || health.runningBuildId === run.after.buildId) &&
    health.serviceRunning === true &&
    health.versionMatch === true &&
    health.readyz !== false &&
    health.settled !== false &&
    health.channelsReady !== false &&
    health.pluginErrors?.length === 0 &&
    completed(["openclaw doctor", "post-update verification"]) &&
    completed(["gateway verification", "verifying"]) &&
    run.origin.updateRecoveryCapture?.status !== "restore-failed" &&
    run.origin.updateRecoveryCapture?.restored !== true
  );
}

/** Admission may settle a completed prior update, but never adopt unresolved recovery. */
export async function resolveCompletedDoctorUpdateRecovery(params: {
  installRoot: string;
  executorFence: UpdateRecoveryFence;
  runtime: RuntimeEnv;
}): Promise<void> {
  params.executorFence.assertCurrent();
  const { inspectUpdateRecoveryBackups } = await import("../infra/update-recovery-backup.js");
  const { getUpdateRun } = await import("../infra/update-run-ledger.js");
  const inspections = await inspectUpdateRecoveryBackups({ installRoot: params.installRoot });
  params.executorFence.assertCurrent();
  for (const inspection of inspections) {
    if (
      inspection.terminalOutcome !== "committed" ||
      inspection.captureStatus === "restored" ||
      inspection.captureStatus === "restore-failed" ||
      !hasVerifiedCompletedUpdate(getUpdateRun(inspection.runId))
    ) {
      continue;
    }
    await retireDoctorResolvedCapture(inspection.ref, params.runtime, undefined, params);
  }
}

/** Doctor and update admission share terminal reconciliation without replaying stale captures. */
async function retireDoctorResolvedCapture(
  ref: UpdateRecoveryBackupRef,
  runtime: RuntimeEnv,
  retirement?: { runId: string; installRoot: string },
  admission?: { installRoot: string; executorFence: UpdateRecoveryFence },
): Promise<void> {
  const {
    readUpdateRecoveryBackupManifest,
    inspectUpdateRecoveryBackups,
    reconcileUpdateRecoveryBackupOutcome,
    retireUpdateRecoveryBackup,
  } = await import("../infra/update-recovery-backup.js");
  const { withUpdateCommandExecutor } =
    await import("../cli/update-cli/update-command-executor.js");
  const manifest = retirement
    ? undefined
    : await readUpdateRecoveryBackupManifest(ref, {
        assertOwned: () => admission?.executorFence.assertCurrent(),
      });
  const target = retirement ?? manifest;
  if (!target) {
    throw new Error("Capture retirement has no recorded identity");
  }
  if (admission && target.installRoot !== path.resolve(admission.installRoot)) {
    throw new Error(`Update capture belongs to another installation: ${ref.manifestPath}`);
  }
  const drivers = manifest ? [manifest.creator, ...manifest.drivers] : [];
  const { assertUpdateRecoveryAdmission } =
    await import("../infra/update-run-recovery-admission.js");
  const { assertNoPendingUpdateRecovery } = await import("../infra/update-run-recovery.js");
  const { getUpdateRun } = await import("../infra/update-run-ledger.js");
  const retire = async (fence: UpdateRecoveryFence) => {
    fence.assertCurrent();
    await assertUpdateRecoveryAdmission({ env: process.env });
    const assertOwned = () => {
      fence.assertCurrent();
      assertNoPendingUpdateRecovery({ env: process.env });
      assertRecoveryDriversExited(drivers);
      if (admission) {
        if (!hasVerifiedCompletedUpdate(getUpdateRun(target.runId))) {
          throw new Error(
            `Update capture has no proven successful outcome: ${ref.manifestPath}. Inspect with openclaw update status --json; resolve with npx openclaw@latest doctor --fix.`,
          );
        }
      }
    };
    if (!retirement) {
      const current = (await inspectUpdateRecoveryBackups()).find(
        (entry) =>
          entry.ref.directory === ref.directory && entry.ref.manifestSha256 === ref.manifestSha256,
      );
      if (
        current?.status !== "stale" ||
        (admission &&
          (current.terminalOutcome !== "committed" ||
            current.captureStatus === "restored" ||
            current.captureStatus === "restore-failed"))
      ) {
        throw new Error(
          `Capture resolution is ambiguous: ${ref.manifestPath}. Inspect with openclaw update status --json.`,
        );
      }
      if (admission) {
        await reconcileUpdateRecoveryBackupOutcome(current, { assertOwned });
      }
    }
    assertOwned();
    await retireUpdateRecoveryBackup(ref, { assertOwned });
    runtime.log(`Resolved update capture retired: ${ref.manifestPath}`);
  };
  if (admission) {
    await retire(admission.executorFence);
  } else {
    await withUpdateCommandExecutor(target.runId, async (executor) =>
      retire(await executor.enter(target.installRoot)),
    );
  }
}
