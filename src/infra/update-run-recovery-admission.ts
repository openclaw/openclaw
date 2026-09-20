import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db-contract.js";
import { withExistingOpenClawStateDatabaseCurrentReadOnly } from "../state/openclaw-state-db-readonly.js";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { clearNodeSqliteKyselyCacheForDatabase } from "./kysely-sync-cache-state.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import { hasNodeErrorCode } from "./path-guards.js";
import { prepareSqliteReadOnlyLocation } from "./sqlite-snapshot-source.js";
import type { UpdateRecoveryBackupRef } from "./update-recovery-backup-contract.js";
import type { UpdateRunLedgerOptions as LedgerOptions } from "./update-run-codec.js";
import {
  readUpdateRunDriver,
  requireUnprotectedGatewayUpdate,
  sameUpdateRunDriver,
} from "./update-run-driver.js";
import { bindUnprotectedGatewayUpdateDriver, getUpdateRun } from "./update-run-ledger.js";
import {
  isUpdateRecoveryPending,
  UpdateRecoveryRequiredError,
} from "./update-run-recovery-schema.js";
import { readRecoveries } from "./update-run-recovery-store.js";
import { assertNoPendingUpdateRecovery } from "./update-run-recovery.js";
async function inspectUpdateRecoveryDatabasePath(
  options: OpenClawStateDatabaseOptions,
): Promise<string | undefined> {
  const databasePath = path.resolve(
    options.path ?? resolveOpenClawStateSqlitePath(options.env ?? process.env),
  );
  return (await assertUpdateRecoveryDirectoryAdmission(databasePath)) ? databasePath : undefined;
}

/** Read-only admission; neither a missing nor a replaced DB retires old recovery. */
export async function assertUpdateRecoveryAdmission(
  options: OpenClawStateDatabaseOptions = {},
): Promise<void> {
  const databasePath = await inspectUpdateRecoveryDatabasePath(options);
  if (databasePath) {
    assertNoPendingUpdateRecovery({ ...options, path: databasePath });
  }
}

/** Recheck the existing admission at a synchronous publication transaction boundary. */
export function assertUpdateRecoveryPublicationAdmission(
  options: OpenClawStateDatabaseOptions = {},
): void {
  const databasePath = path.resolve(options.path ?? resolveOpenClawStateSqlitePath(options.env));
  let families: string[];
  try {
    families = fsSync.readdirSync(path.dirname(databasePath));
  } catch (error) {
    if (hasNodeErrorCode(error, "ENOENT")) {
      return;
    }
    throw error;
  }
  assertRecoveryDirectoryNamesAdmission(families);
  // Publication cannot inherit a discovery snapshot from before a new recovery.
  withExistingOpenClawStateDatabaseCurrentReadOnly(
    ({ db }) => {
      const pending = readRecoveries(db).find(isUpdateRecoveryPending);
      if (pending) {
        throw new UpdateRecoveryRequiredError(pending);
      }
    },
    { ...options, path: databasePath },
  );
}

/** Inspect only the stable recovery namespace before restoring a verified state set. */
export async function assertUpdateRecoveryBackupAdmission(
  options: OpenClawStateDatabaseOptions,
  assertOwned: () => void,
): Promise<void> {
  assertOwned();
  const databasePath = await inspectUpdateRecoveryDatabasePath(options);
  assertOwned();
  if (!databasePath) {
    return;
  }
  try {
    await fs.stat(databasePath);
  } catch (error) {
    if (!hasNodeErrorCode(error, "ENOENT")) {
      throw error;
    }
    assertOwned();
    return;
  }
  assertOwned();
  // The old runtime must not apply its schema ceiling to the state it needs to
  // restore. Inspect the existing namespace in a private, artifact-preserving copy.
  const snapshot = await prepareSqliteReadOnlyLocation(databasePath, {
    preserveSourceArtifacts: true,
  });
  try {
    assertOwned();
    const db = openNodeSqliteDatabase(snapshot.location, { readOnly: true });
    try {
      if (!tableExists(db, "config_machine_state")) {
        throw new Error("Update recovery metadata is unavailable; automatic rollback was refused.");
      }
      const pending = readRecoveries(db).find(isUpdateRecoveryPending);
      if (pending) {
        throw new UpdateRecoveryRequiredError(pending);
      }
      assertOwned();
    } finally {
      clearNodeSqliteKyselyCacheForDatabase(db);
      db.close();
    }
  } finally {
    snapshot.cleanup();
  }
}

export type UnprotectedGatewayUpdateContext = { runId: string; assertCurrent: () => void };

/** A run ID selects a declaration; the child's actual parent must still own that run. */
export function readUnprotectedGatewayUpdateParent(
  options: LedgerOptions = {},
): UnprotectedGatewayUpdateContext | undefined {
  const runId = (options.env ?? process.env).OPENCLAW_UPDATE_RUN_ID?.trim();
  if (!runId || !getUpdateRun(runId, options)?.origin.unprotectedGatewayUpdate) {
    return undefined;
  }
  const parent = readUpdateRunDriver(process.ppid);
  const assertCurrent = () => {
    const { record, declaration } = requireUnprotectedGatewayUpdate(getUpdateRun(runId, options));
    const currentParent = readUpdateRunDriver(process.ppid);
    if (
      !parent ||
      !currentParent ||
      !sameUpdateRunDriver(parent, currentParent) ||
      !record.origin.driver ||
      !sameUpdateRunDriver(record.origin.driver, parent) ||
      ![declaration.owner, declaration.finalizer].some(
        (driver) => driver && sameUpdateRunDriver(driver, parent),
      )
    ) {
      throw new Error(
        "Unprotected Gateway update does not belong to this Doctor or finalizer parent.",
      );
    }
  };
  assertCurrent();
  return { runId, assertCurrent };
}

/** Bind one actual finalizer child before it can pass the exception to its own Doctor children. */
export function bindUnprotectedGatewayUpdateFinalizer(
  parent: UnprotectedGatewayUpdateContext,
  options: LedgerOptions = {},
): UnprotectedGatewayUpdateContext {
  parent.assertCurrent();
  const self = readUpdateRunDriver();
  bindUnprotectedGatewayUpdateDriver(parent.runId, options);
  const assertCurrent = () => {
    const { record, declaration } = requireUnprotectedGatewayUpdate(
      getUpdateRun(parent.runId, options),
    );
    const currentParent = readUpdateRunDriver(process.ppid);
    if (
      !self ||
      !currentParent ||
      !sameUpdateRunDriver(declaration.owner, currentParent) ||
      !declaration.finalizer ||
      !sameUpdateRunDriver(declaration.finalizer, self) ||
      !record.origin.driver ||
      !sameUpdateRunDriver(record.origin.driver, self)
    ) {
      throw new Error("Unprotected Gateway finalizer lost its declared run ownership.");
    }
  };
  assertCurrent();
  return { runId: parent.runId, assertCurrent };
}

/** Check publication before an admitted row reader; false means the parent is absent. */
export async function assertUpdateRecoveryDirectoryAdmission(
  databasePath: string,
): Promise<boolean> {
  const parent = path.dirname(databasePath);
  try {
    await fs.lstat(parent);
  } catch (error) {
    if (!hasNodeErrorCode(error, "ENOENT")) {
      throw error;
    }
    return false;
  }
  // A family may hold the only original DB even when another canonical file
  // exists. Locators confer no authority to inspect, repair, or retire it.
  // Do not swallow discovery races or recreate an absent canonical database.
  const families = await fs.readdir(parent);
  assertRecoveryDirectoryNamesAdmission(families);
  return true;
}

function assertRecoveryDirectoryNamesAdmission(families: string[]): void {
  if (families.some((name) => name.startsWith(".openclaw-restore-"))) {
    throw new Error(
      "Interrupted shared-database publication is read-only while full-state recovery is deferred",
    );
  }
}

type UpdateRecoveryInvocationAuthority = {
  active: boolean;
  protected: boolean;
  rehearsal?: boolean;
  guard?: () => void;
  refusal?: { error: unknown };
  maintenance?: { assertCurrent: () => void };
  assertRecoveryClaim?: () => void;
  reference?: UpdateRecoveryBackupRef;
  backupRunId?: string;
};

/** Bind one invocation; a refused or replaced owner cannot recover its authority. */
export function captureUpdateRecoveryInvocationGuard(
  scope: UpdateRecoveryInvocationAuthority | undefined,
): (() => void) | undefined {
  if (!scope || (!scope.protected && !scope.rehearsal && !scope.guard)) {
    return undefined;
  }
  if (!scope.guard) {
    const maintenance = scope.maintenance;
    const assertMaintenanceCurrent = maintenance?.assertCurrent.bind(maintenance);
    const claim = scope.assertRecoveryClaim;
    const reference = scope.reference;
    const manifestSha256 = reference?.manifestSha256;
    const backupRunId = scope.backupRunId;
    scope.guard = () => {
      if (scope.refusal) {
        throw scope.refusal.error;
      }
      try {
        if (
          !scope.active ||
          !maintenance ||
          scope.maintenance !== maintenance ||
          scope.assertRecoveryClaim !== claim ||
          scope.reference !== reference ||
          reference?.manifestSha256 !== manifestSha256 ||
          scope.backupRunId !== backupRunId
        ) {
          throw new Error("Doctor recovery lost its original invocation authority.");
        }
        assertMaintenanceCurrent?.();
        claim?.();
      } catch (error) {
        scope.refusal = { error };
        throw error;
      }
    };
  }
  scope.guard();
  return scope.guard;
}
