import { stat } from "node:fs/promises";
import { cloneEnvWithPlatformSemantics } from "../../config/config-env-vars.js";
import {
  CommandProcessCleanupError,
  hasCommandProcessCleanupError,
} from "../../process/exec-result.js";
import {
  withArtifactPreservingStateReads,
  executeExistingOpenClawStateRead,
  withOpenClawStateDatabaseReadSnapshot,
} from "../../state/openclaw-state-db-readonly.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import {
  captureOpenClawStateReadContext,
  captureOpenClawStateWorkerContext,
} from "../../state/openclaw-state-worker-context.js";
import { runOpenClawStateWorkerOperation } from "../../state/openclaw-state-worker-store.js";
import { hasErrnoCode } from "../errno.js";
import { runSqliteReadOnlyOperation } from "../sqlite-readonly-worker.js";
import { hasSqliteWorkerOutcomeUnknown } from "../sqlite-worker-contract.js";
import { createSqliteWorkerWriteAdmission } from "../sqlite-worker-store.js";
import type { UpdateRunWriteOptions } from "../update-run-write.async.js";
import {
  assertUpgradeRecipeReceiptRollbackAllowed,
  upgradeRecipeMaintenanceBindingSchema,
  upgradeRecipeMaintenanceReceiptSchema,
  type UpgradeRecipeMaintenanceBinding,
  type UpgradeRecipeMaintenanceReceipt,
} from "./maintenance-contract.js";

/** Passive worker read: absent shared state stays absent; corrupt receipts refuse startup. */
export async function readUpgradeRecipeMaintenanceReceipt(
  options: { path?: string; env?: NodeJS.ProcessEnv; signal?: AbortSignal } = {},
): Promise<UpgradeRecipeMaintenanceReceipt | null> {
  const env = cloneEnvWithPlatformSemantics(options.env ?? process.env);
  const pathname = options.path ?? resolveOpenClawStateSqlitePath(env);
  try {
    await stat(pathname);
  } catch (error) {
    if (hasErrnoCode(error, "ENOENT")) {
      return null;
    }
    throw error;
  }
  const source = captureOpenClawStateReadContext(pathname);
  options.signal?.throwIfAborted();
  source.admission.assertCurrent();
  if (source.maintenanceScope) {
    // Legacy initialization retains source custody in this process. Its existing
    // read owner must make the private snapshot; a fresh child cannot borrow that authority.
    source.maintenanceScope.assertReadAdmission();
    source.admission.assertCurrent();
    const reply = await withArtifactPreservingStateReads(() =>
      withOpenClawStateDatabaseReadSnapshot(
        () =>
          executeExistingOpenClawStateRead(
            { path: pathname, env },
            { type: "upgradeMaintenance.read", input: undefined },
            { signal: options.signal },
          ),
        { path: pathname, env },
      ),
    );
    source.admission.assertCurrent();
    source.maintenanceScope.assertReadAdmission();
    if (!reply) {
      return null;
    }
    if (!reply.ok || reply.type !== "upgradeMaintenance.read") {
      throw new Error("Upgrade maintenance receipt worker returned an unexpected result.");
    }
    return upgradeRecipeMaintenanceReceiptSchema.nullable().parse(reply.receipt);
  }

  const receipt = await runSqliteReadOnlyOperation(
    pathname,
    { type: "upgradeMaintenance.read", input: undefined },
    {
      source: "canonical",
      expectedIdentity: source.admission.identity.key,
      env,
      signal: options.signal,
    },
  );
  source.admission.assertCurrent();
  return receipt === null ? null : upgradeRecipeMaintenanceReceiptSchema.parse(receipt);
}

/** Evidence can prohibit compensation; it never supplies authority to perform it. */
export async function assertUpgradeRecipeRollbackAllowed(
  runId: string | undefined,
  options: { path?: string; env?: NodeJS.ProcessEnv; signal?: AbortSignal } = {},
): Promise<void> {
  const receipt = await readUpgradeRecipeMaintenanceReceipt(options);
  assertUpgradeRecipeReceiptRollbackAllowed(receipt, runId);
}

/** Captures the existing update executor and canonical-state generation, never a second lease. */
export function createUpgradeRecipeMaintenanceOwner(
  binding: UpgradeRecipeMaintenanceBinding,
  options: UpdateRunWriteOptions & { assertCurrent: () => void },
) {
  const capturedBinding = upgradeRecipeMaintenanceBindingSchema.parse(binding);
  const context = options.context ?? captureOpenClawStateWorkerContext(options);
  const assertCurrent = () => {
    context.admission.assertCurrent();
    options.signal?.throwIfAborted();
    options.assertCurrent();
  };
  const read = () =>
    readUpgradeRecipeMaintenanceReceipt({
      path: context.admission.databasePath,
      env: options.env,
      signal: options.signal,
    });
  const record = async (
    phase: UpgradeRecipeMaintenanceReceipt["phase"],
    expectedRevision: number | null,
  ) => {
    options.assertAccepting?.();
    assertCurrent();
    const pending = runOpenClawStateWorkerOperation(
      context,
      (scope) =>
        scope.execute({
          type: "upgradeMaintenance.record",
          input: { binding: capturedBinding, expectedRevision, phase },
        }),
      {
        existingOnly: true,
        assertCurrent,
        createAdmission: createSqliteWorkerWriteAdmission(assertCurrent, [
          context.admission.databasePath,
        ]),
      },
    );
    options.retainSettlement?.(pending.then(() => undefined));
    const receipt = await pending.catch((error: unknown) => {
      if (hasSqliteWorkerOutcomeUnknown(error) && !hasCommandProcessCleanupError(error)) {
        throw new CommandProcessCleanupError({ cause: error });
      }
      throw error;
    });
    assertCurrent();
    if (!receipt) {
      throw new Error("Upgrade maintenance state disappeared before recording its receipt.");
    }
    return upgradeRecipeMaintenanceReceiptSchema.parse(receipt);
  };
  return {
    binding: capturedBinding,
    assertCurrent,
    read,
    requireMaintenance: (expectedRevision: number | null) =>
      record("maintenance-required", expectedRevision),
    recordCommitIntent: (expectedRevision: number) => record("commit-intent", expectedRevision),
    recordCommitted: (expectedRevision: number) => record("committed", expectedRevision),
    verifyCommitIntent: async (expected: UpgradeRecipeMaintenanceBinding) => {
      assertCurrent();
      const receipt = await read();
      assertCurrent();
      if (
        !receipt ||
        receipt.phase !== "commit-intent" ||
        JSON.stringify(receipt.binding) !== JSON.stringify(expected) ||
        JSON.stringify(expected) !== JSON.stringify(capturedBinding)
      ) {
        throw new Error(
          "Gateway upgrade commit requires the exact durable COMMIT_INTENT and live executor.",
        );
      }
    },
  };
}
