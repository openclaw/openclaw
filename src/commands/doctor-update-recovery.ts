import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { hashConfigRaw } from "../config/io.read-helpers.js";
import { resolveConfigPath } from "../config/paths.js";
import { withConfigFileWriteCapture } from "../config/write-capture.js";
import { hasErrnoCode } from "../infra/errno.js";
import { formatErrorMessage, toErrorObject } from "../infra/errors.js";
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
import { inspectUpdateRunDriver, type UpdateRunDriver } from "../infra/update-run-driver.js";
import { ExitError, type RuntimeEnv } from "../runtime.js";
import type { beginDoctorMaintenance } from "./doctor-maintenance.js";
import type { DoctorOptions } from "./doctor-prompter.js";

type DoctorRecoveryScope = {
  runtime: RuntimeEnv;
  prepared: boolean;
  protected: boolean;
  storesClosed?: boolean;
  backup?: UpdateRecoveryBackupRef;
  reference?: UpdateRecoveryBackupRef;
  assertRecoveryClaim?: () => void;
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
          const { writeUpdateRecoveryBackupOutcome } =
            await import("../infra/update-recovery-backup.js");
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
              await writeUpdateRecoveryBackupOutcome(
                scope.backup,
                { status: "committed" },
                { assertOwned: () => assertDoctorRecoveryCurrent(scope) },
              );
            } catch (error) {
              assertDoctorRecoveryCurrent(scope);
              scope.runtime.error(
                `Warning: Doctor completed, but its retained backup outcome could not be recorded at ${scope.backup.manifestPath}: ${String(error)}`,
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
  const maintenance = scope.maintenance;
  if (!maintenance) {
    throw new Error("Doctor recovery lost maintenance ownership.");
  }
  const authority = { assertOwned: () => assertDoctorRecoveryCurrent(scope) };
  try {
    // Lease release can write shared state; finish it before restoring the old schema.
    await maintenance.closeStores();
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
  if (marked && (options.updateRecoveryOwner !== "driver" || !supplied?.trim())) {
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
  if (!updating && options.repair !== true && options.yes !== true) {
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
  const pending = !updating ? await backup.findPendingUpdateRecoveryBackup() : null;
  if (!updating && !pending) {
    return;
  }
  if (pending) {
    const manifest = await backup.verifyUpdateRecoveryBackup(pending);
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
    await restoreDoctorBackup(scope, pending);
    // Normal repair now owns the restored state; retain only its maintenance lease.
    return;
  }
  const reference =
    supplied !== undefined
      ? backup.readUpdateRecoveryBackupRef(supplied)
      : await backup.createUpdateRecoveryBackup({
          runId: randomUUID(),
          installRoot: root,
          drivers: (await activeUpdateRuns()).flatMap(recordedUpdateRunDrivers),
          assertOwned: () => maintenance.assertCurrent(),
        });
  await backup.verifyUpdateRecoveryBackup(reference);
  maintenance.assertCurrent();
  scope.reference = reference;
  if (supplied === undefined) {
    await backup.writeUpdateRecoveryBackupOutcome(
      reference,
      { status: "pending" },
      {
        assertOwned: () => maintenance.assertCurrent(),
      },
    );
    scope.backup = reference;
  }
  scope.protected = true;
}

export function hasVerifiedDoctorUpdateRecovery(): boolean {
  const scope = doctorRecovery.getStore();
  if (!scope?.protected) {
    return false;
  }
  scope.maintenance?.assertCurrent();
  return true;
}

/** Process exit must unwind the recovery owner before terminating the Doctor child. */
export function doctorUpdateRecoveryRuntime(runtime: RuntimeEnv): RuntimeEnv {
  if (!doctorRecovery.getStore()?.maintenance) {
    return runtime;
  }
  return {
    ...runtime,
    exit(code) {
      throw new ExitError(code);
    },
  };
}
