import { OPENCLAW_AGENT_SCHEMA_VERSION } from "../state/openclaw-agent-db.js";
import {
  OpenClawDatabaseSchemaPreflightError,
  preflightOpenClawDatabaseSchemas,
} from "../state/openclaw-database-preflight.js";
import {
  closeOpenClawStateDatabase,
  OPENCLAW_STATE_SCHEMA_VERSION,
} from "../state/openclaw-state-db.js";
import { acquireGatewayLock } from "./gateway-lock.js";
import {
  clearRestartSentinelIfRevision,
  readRestartSentinel,
  readRestartSentinelReadOnly,
  writeRestartSentinel,
  writeRestartSentinelToStateSnapshot,
} from "./restart-sentinel.js";
import { generateSecureUuid } from "./secure-random.js";
import {
  commitUpdateRecoveryJournal,
  readUpdateRecoveryJournal,
  resolveUpdateRecoveryJournalPathFromSnapshot,
} from "./update-recovery-journal.js";
import { restoreRetainedPackageForUpdate } from "./update-retention.js";
import {
  readUpdateStateSnapshot,
  removeUpdateStateSnapshot,
  restoreUpdateStateSnapshot,
} from "./update-state-snapshot.js";
import {
  advanceUpdateTransactionMarker,
  claimUpdateTransactionRollback,
  isUpdateTransactionConfirmed,
  isUpdateTransactionMarker,
  isUpdateTransactionProbationReleased,
} from "./update-transaction-marker.js";

const IMMEDIATELY_RECOVERABLE_PHASES = new Set(["rolling-back", "failed"]);
const LEASE_GUARDED_PHASES = new Set([
  "snapshot",
  "verify",
  "swap",
  "restart",
  "healthy",
  "confirm",
]);
const CONFIRMED_CLEANUP_RETRY_MS = 1_000;
const confirmedCleanupTimers = new Map<string, ReturnType<typeof setTimeout>>();

export function scheduleConfirmedUpdateCleanup(params: {
  handoffId: string;
  runAtMs: number;
  env: NodeJS.ProcessEnv;
}): void {
  if (confirmedCleanupTimers.has(params.handoffId)) {
    return;
  }
  const timer = setTimeout(
    async () => {
      confirmedCleanupTimers.delete(params.handoffId);
      try {
        await cleanupConfirmedUpdateAfterLease(params.handoffId, params.env);
      } catch {
        scheduleConfirmedUpdateCleanup({
          handoffId: params.handoffId,
          runAtMs: Date.now() + CONFIRMED_CLEANUP_RETRY_MS,
          env: params.env,
        });
      }
    },
    Math.max(1, params.runAtMs - Date.now()),
  );
  timer.unref?.();
  confirmedCleanupTimers.set(params.handoffId, timer);
}

async function cleanupConfirmedUpdateAfterLease(
  handoffId: string,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const marker = await readRestartSentinel(env);
  const payload = marker?.payload;
  if (
    !marker ||
    !payload ||
    !isUpdateTransactionMarker(payload) ||
    payload.stats?.handoffId !== handoffId ||
    (!isUpdateTransactionProbationReleased(payload) && payload.stats?.updatePhase !== "complete")
  ) {
    return;
  }
  const leaseExpiresAt = payload.stats?.updateOwnerLeaseExpiresAtMs;
  if (typeof leaseExpiresAt === "number" && leaseExpiresAt > Date.now()) {
    scheduleConfirmedUpdateCleanup({ handoffId, runAtMs: leaseExpiresAt + 1, env });
    return;
  }
  const stateSnapshotRoot = payload.stats?.stateSnapshotRoot;
  if (stateSnapshotRoot) {
    try {
      await removeUpdateStateSnapshot(await readUpdateStateSnapshot(stateSnapshotRoot));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }
  if (!(await clearRestartSentinelIfRevision(marker.revision, env))) {
    scheduleConfirmedUpdateCleanup({
      handoffId,
      runAtMs: Date.now() + CONFIRMED_CLEANUP_RETRY_MS,
      env,
    });
  }
}

export function resetInterruptedUpdateRecoveryForTests(): void {
  for (const timer of confirmedCleanupTimers.values()) {
    clearTimeout(timer);
  }
  confirmedCleanupTimers.clear();
}

/**
 * Recover a durable transaction that died before the replacement Gateway
 * entered probation. Restoration acquires the same exclusive state/config
 * ownership used by Gateway startup and SQLite maintenance before touching the
 * package or live database tree.
 */
export async function recoverInterruptedUpdateBeforeGatewayStart(
  env: NodeJS.ProcessEnv = process.env,
  nowMs = Date.now(),
  deps: {
    acquireExclusiveStateOwnership?: (
      env: NodeJS.ProcessEnv,
    ) => Promise<{ release: () => Promise<void> }>;
  } = {},
): Promise<"continue" | "owner-active" | "rolled-back"> {
  const marker = readRestartSentinelReadOnly(env);
  let payload = marker?.payload;
  if (!payload || !isUpdateTransactionMarker(payload)) {
    return "continue";
  }
  const schemas = preflightOpenClawDatabaseSchemas({
    env,
    supportedVersions: {
      state: OPENCLAW_STATE_SCHEMA_VERSION,
      agent: OPENCLAW_AGENT_SCHEMA_VERSION,
    },
  });
  if (schemas.incompatible.length > 0) {
    throw new OpenClawDatabaseSchemaPreflightError(schemas.incompatible);
  }
  if (schemas.indeterminate.length > 0) {
    throw new Error(
      `interrupted update recovery could not inspect SQLite state: ${schemas.indeterminate
        .map((database) => `${database.path}: ${database.reason}`)
        .join("; ")}`,
    );
  }
  const stateSnapshotRoot = payload.stats?.stateSnapshotRoot;
  if (stateSnapshotRoot) {
    const journal = await readUpdateRecoveryJournal(
      resolveUpdateRecoveryJournalPathFromSnapshot(stateSnapshotRoot),
    ).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw error;
    });
    if (journal && journal.handoffId === payload.stats?.handoffId) {
      if (
        isUpdateTransactionConfirmed(payload) &&
        isUpdateTransactionConfirmed(journal.payload) &&
        (!isUpdateTransactionConfirmed(journal.committedPayload) ||
          (isUpdateTransactionProbationReleased(payload) &&
            isUpdateTransactionProbationReleased(journal.payload) &&
            !isUpdateTransactionProbationReleased(journal.committedPayload)))
      ) {
        await commitUpdateRecoveryJournal({
          filePath: resolveUpdateRecoveryJournalPathFromSnapshot(stateSnapshotRoot),
          handoffId: journal.handoffId,
          payload,
        });
      } else if (JSON.stringify(payload) !== JSON.stringify(journal.committedPayload)) {
        await writeRestartSentinel(journal.committedPayload, env);
        payload = journal.committedPayload;
      } else {
        payload = journal.committedPayload;
      }
    }
  }
  if (isUpdateTransactionProbationReleased(payload) || payload.stats?.updatePhase === "complete") {
    const leaseExpiresAt = payload.stats?.updateOwnerLeaseExpiresAtMs;
    if (typeof leaseExpiresAt === "number" && leaseExpiresAt > nowMs) {
      scheduleConfirmedUpdateCleanup({
        handoffId: payload.stats!.handoffId!,
        runAtMs: leaseExpiresAt + 1,
        env,
      });
      return "continue";
    }
    try {
      await cleanupConfirmedUpdateAfterLease(payload.stats!.handoffId!, env);
    } catch {
      scheduleConfirmedUpdateCleanup({
        handoffId: payload.stats!.handoffId!,
        runAtMs: Date.now() + CONFIRMED_CLEANUP_RETRY_MS,
        env,
      });
    }
    return "continue";
  }
  const phase = payload.stats?.updatePhase ?? "";
  const confirmationRejected =
    payload.stats?.confirmationStatus === "failed" ||
    payload.stats?.confirmationStatus === "timed-out";
  if (
    confirmationRejected &&
    LEASE_GUARDED_PHASES.has(phase) &&
    typeof payload.stats?.updateOwnerLeaseExpiresAtMs === "number" &&
    payload.stats.updateOwnerLeaseExpiresAtMs > nowMs
  ) {
    // The detached updater still owns compensation. Never start the candidate
    // outside probation while that owner is preparing rollback.
    return "owner-active";
  }
  if (!IMMEDIATELY_RECOVERABLE_PHASES.has(phase)) {
    if (!LEASE_GUARDED_PHASES.has(phase)) {
      return "continue";
    }
    if (
      typeof payload.stats?.updateOwnerLeaseExpiresAtMs === "number" &&
      payload.stats.updateOwnerLeaseExpiresAtMs > nowMs
    ) {
      return phase === "snapshot" || phase === "verify" || phase === "swap"
        ? "owner-active"
        : "continue";
    }
  }
  const packageRoot = payload.stats?.packageRoot;
  const retainedPackageRoot = payload.stats?.retainedPackageRoot;
  if (!packageRoot || !retainedPackageRoot || !stateSnapshotRoot) {
    throw new Error("interrupted update marker is missing rollback paths");
  }

  const ownership = await (
    deps.acquireExclusiveStateOwnership ??
    (async (lockEnv) => {
      const lock = await acquireGatewayLock({
        env: lockEnv,
        role: "sqlite-maintenance",
        allowInTests: true,
      });
      if (!lock) {
        throw new Error("exclusive Gateway state ownership is unavailable");
      }
      return lock;
    })
  )(env);
  try {
    const rollbackOwner = generateSecureUuid();
    const claimed = await claimUpdateTransactionRollback({
      handoffId: payload.stats!.handoffId!,
      rollbackOwner,
      reason: "interrupted before gateway probation",
      requireExpiredLease: true,
      now: nowMs,
      env,
    });
    if (!claimed) {
      const current = await readRestartSentinel(env);
      const currentPayload = current?.payload;
      if (
        currentPayload &&
        currentPayload.stats?.handoffId === payload.stats?.handoffId &&
        isUpdateTransactionConfirmed(currentPayload)
      ) {
        return "continue";
      }
      throw new Error("interrupted update rollback is owned by another process");
    }

    const snapshot = await readUpdateStateSnapshot(stateSnapshotRoot);
    closeOpenClawStateDatabase();
    await restoreRetainedPackageForUpdate({ retainedRoot: retainedPackageRoot, packageRoot });
    await restoreUpdateStateSnapshot(snapshot, {
      prepareStagedState: async (stagedStateDir) => {
        writeRestartSentinelToStateSnapshot(claimed.payload, stagedStateDir);
      },
    });
    const completed = await advanceUpdateTransactionMarker({
      handoffId: payload.stats!.handoffId!,
      phase: "rolled-back",
      rollbackOwner,
      confirmationStatus: "failed",
      status: "error",
      reason: "update-rollback-completed: interrupted before gateway probation",
      env,
    });
    if (!completed) {
      throw new Error("interrupted update marker changed before state restoration completed");
    }
    closeOpenClawStateDatabase();
    return "rolled-back";
  } finally {
    await ownership.release();
  }
}
