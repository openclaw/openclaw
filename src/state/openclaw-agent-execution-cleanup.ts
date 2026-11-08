import { readFile, stat } from "node:fs/promises";
import { coerceErrorMessage } from "@openclaw/normalization-core/error-coercion";
import { hasErrnoCode } from "../infra/errno.js";
import { parseGatewayLockPayload } from "../infra/gateway-lock-payload.js";
import {
  resolveGatewayStateOwnerPath,
  type captureGatewayStateOwner,
} from "../infra/gateway-state-owner.js";
import { throwSqliteLifecycleErrors } from "../infra/sqlite-lifecycle-errors.js";
import { publishSqliteWalCheckpointObservation } from "../infra/sqlite-wal-checkpoint.js";
import type { SqliteWorkerCloseReceipt } from "../infra/sqlite-worker-contract.js";
import {
  assertDatabaseFileIdentity,
  readDatabasePathIdentity,
} from "../infra/sqlite-worker-identity.js";
import { createSqliteWorkerOperationAdmission } from "../infra/sqlite-worker-operation-admission.js";
import {
  closeUnclaimedSharedStateSqliteWorkers,
  runSqliteWorkerStoreOperation,
} from "../infra/sqlite-worker-store.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { OpenClawAgentDatabaseWorkerLeaseReceipt } from "./openclaw-agent-db-lease.js";
import { invalidateOpenClawAgentDatabaseValidation } from "./openclaw-agent-db-validation-cache.js";
import type {
  AgentDatabaseFileExecutionIdentity,
  AgentDatabaseNativeStore,
} from "./openclaw-agent-execution-contract.js";
import type { OpenClawStateWorkerContext } from "./openclaw-state-worker-context.types.js";
import { openOpenClawStateWorkerCleanupStore } from "./openclaw-state-worker-store.js";

/** Release only this owner's prepared lease after the broker certifies native retirement. */
export async function cleanupRetiredAgentDatabaseLease(params: {
  context: OpenClawStateWorkerContext;
  stopped: Promise<void>;
  assertOwned(): void;
  lease: OpenClawAgentDatabaseWorkerLeaseReceipt;
  readOpenRefused?: () => boolean;
  closed?: () => ReturnType<typeof readAgentDatabaseClosedReceipt>;
}): Promise<void> {
  params.assertOwned();
  await params.stopped;
  params.assertOwned();
  const refusedBeforeAgentOpen = params.readOpenRefused?.() === true;
  // A confirmed native close already released its lease; exit alone still needs recovery.
  if (params.closed?.()) {
    return;
  }
  const observed = await readDatabasePathIdentity(params.lease.sharedStatePath);
  if (observed.key !== params.lease.sharedStateIdentity) {
    throw new Error("Retired agent cleanup cannot adopt a replacement shared database");
  }
  params.assertOwned();
  // Uncertified retirement cannot lend proof while shared-state cleanup admission waits.
  if (!refusedBeforeAgentOpen) {
    invalidateOpenClawAgentDatabaseValidation(params.lease.path);
  }
  const context = {
    environment: params.context.environment,
    existingSchemaPath: params.context.existingSchemaPath,
    stateIntegrity: params.context.stateIntegrity,
  };
  const store = await openOpenClawStateWorkerCleanupStore(
    params.lease.sharedStatePath,
    context,
    () => params.assertOwned(),
    observed,
    params.context.maintenanceScope,
  ).catch((error: unknown) => {
    if (error instanceof Error) {
      error.message += ` (leaseId=${params.lease.leaseId}, path=${params.lease.path})`;
      error.stack = `${error.name}: ${error.message}\n${error.stack ?? ""}`;
    }
    throw error;
  });
  if (!store) {
    throw new Error("Retired agent cleanup lost its original shared database");
  }
  const errors: unknown[] = [];
  try {
    await runSqliteWorkerStoreOperation(
      store,
      (scope) =>
        scope.execute({
          type: "agentDatabases.releaseExitedLease",
          input: {
            ...params.lease,
            outcome: refusedBeforeAgentOpen ? "refused-before-open" : "unknown",
          },
        }),
      context,
      () => params.assertOwned(),
      () => ({
        nativeLocations: [params.lease.sharedStatePath],
        admission: createSqliteWorkerOperationAdmission((request, grant) => {
          params.assertOwned();
          if (request.stage === "prepare" && request.facts === "agent-integrity-invalidated") {
            invalidateOpenClawAgentDatabaseValidation(params.lease.path);
          }
          grant();
        }),
      }),
    );
  } catch (error) {
    errors.push(error);
  }
  try {
    await store.close();
  } catch (error) {
    errors.push(error);
  }
  throwSqliteLifecycleErrors(errors, "Retired agent lease cleanup and Worker close failed");
}

/** Native closure is reusable only for the exact incarnation and original worker lease. */
export function readAgentDatabaseClosedReceipt(
  receipt: SqliteWorkerCloseReceipt | undefined,
  identity: AgentDatabaseFileExecutionIdentity | undefined,
  lease: OpenClawAgentDatabaseWorkerLeaseReceipt | undefined,
) {
  if (
    !receipt ||
    !identity ||
    !lease ||
    receipt.incarnation !== identity.incarnation ||
    receipt.identity.key !== `file:${identity.physicalIdentity}` ||
    receipt.identity.canonicalPath !== identity.nativeLocation
  ) {
    return undefined;
  }
  return { receipt, identity, lease };
}

async function publishAgentDatabaseCloseCheckpoint(
  pathname: string,
  closed: ReturnType<typeof readAgentDatabaseClosedReceipt>,
  assertCleanupOwned: () => void,
): Promise<void> {
  const checkpoint = closed?.receipt.checkpoint;
  if (!closed || !checkpoint) {
    return;
  }
  const { receipt, identity, lease } = closed;
  try {
    // Cleanup retains custody after ordinary admission is revoked during shutdown.
    assertCleanupOwned();
    const [selected, native, shared] = await Promise.all([
      stat(pathname, { bigint: true }),
      stat(identity.nativeLocation, { bigint: true }),
      stat(lease.sharedStatePath, { bigint: true }),
    ]);
    assertDatabaseFileIdentity(selected, { key: receipt.identity.key });
    assertDatabaseFileIdentity(native, { key: receipt.identity.key });
    assertDatabaseFileIdentity(shared, { key: lease.sharedStateIdentity });
    assertCleanupOwned();
    publishSqliteWalCheckpointObservation(pathname, checkpoint);
  } catch {
    // A stale diagnostic must not clear another generation's budget or fail native cleanup.
  }
}

/** Join native disposal before deciding whether the original lease can still be settled. */
export async function closeAgentDatabaseNativeGeneration(params: {
  pathname: string;
  context: OpenClawStateWorkerContext;
  processOwner: ReturnType<typeof captureGatewayStateOwner>;
  opening: Promise<AgentDatabaseNativeStore | undefined> | undefined;
  readOpenedStore: () => AgentDatabaseNativeStore | undefined;
  assertCleanupOwned: () => void;
  readRetirement(): {
    stopped: Promise<void> | undefined;
    lease: OpenClawAgentDatabaseWorkerLeaseReceipt | undefined;
    readOpenRefused: (() => boolean) | undefined;
    closed: ReturnType<typeof readAgentDatabaseClosedReceipt>;
  };
}): Promise<void> {
  const { pathname, context, processOwner, opening, readOpenedStore, assertCleanupOwned } = params;
  const errors: unknown[] = [];
  try {
    processOwner?.assertCurrent();
  } catch (error) {
    // Ordinary admission may retire first; only physical ownership loss forbids lease settlement.
    if (processOwner?.signal.aborted) {
      errors.push(error);
    }
  }
  let storeClosed = false;
  if (opening) {
    try {
      await opening.then(
        async (store) => {
          await store?.close();
          storeClosed = store !== undefined;
        },
        () => readOpenedStore()?.close() ?? closeUnclaimedSharedStateSqliteWorkers(pathname),
      );
    } catch (error) {
      errors.push(error);
    }
  }
  const retirement = params.readRetirement();
  // A failed close can leave the Worker running; its retry owns lease cleanup.
  if (
    errors.length === 0 &&
    !processOwner?.signal.aborted &&
    retirement.stopped &&
    retirement.lease
  ) {
    try {
      await cleanupRetiredAgentDatabaseLease({
        context,
        stopped: retirement.stopped,
        assertOwned: assertCleanupOwned,
        lease: retirement.lease,
        readOpenRefused: retirement.readOpenRefused,
        closed: () => (storeClosed ? retirement.closed : undefined),
      });
    } catch (error) {
      errors.push(error);
    }
  }
  if (processOwner?.signal.aborted && retirement.stopped) {
    await finishAgentDatabaseRetirementAfterOwnershipLoss(
      pathname,
      context.admission.databasePath,
      retirement.stopped,
      errors,
    );
    return;
  }
  throwSqliteLifecycleErrors(errors, "Agent native close and lease cleanup failed");
  await publishAgentDatabaseCloseCheckpoint(pathname, retirement.closed, assertCleanupOwned);
}

/** Lost write authority cannot prevent disposal or authorize another lease cleanup write. */
async function finishAgentDatabaseRetirementAfterOwnershipLoss(
  pathname: string,
  stateDatabasePath: string,
  stopped: Promise<void>,
  errors: unknown[],
): Promise<void> {
  await stopped;
  invalidateOpenClawAgentDatabaseValidation(pathname);
  const lockPath = resolveGatewayStateOwnerPath(stateDatabasePath);
  const replacement = await readFile(lockPath, "utf8").then(
    (raw) => {
      const holder = parseGatewayLockPayload(raw);
      return holder ? { pid: holder.pid, role: holder.role } : "unrecognized lock contents";
    },
    (error: unknown) => (hasErrnoCode(error, "ENOENT") ? "lock removed" : "lock unreadable"),
  );
  createSubsystemLogger("state/agent-db").warn(
    "Agent database native handle retired after state ownership loss; lease cleanup deferred to recovery",
    {
      path: pathname,
      lockPath,
      replacement,
      errors: errors.map((error) => coerceErrorMessage(error)),
    },
  );
}
