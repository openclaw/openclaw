import { normalizeAccountId } from "../routing/account-id.js";
import type { RestartSentinel } from "./restart-sentinel-store.js";
import {
  clearRestartSentinelIfRevision,
  readRestartSentinel,
  rewriteRestartSentinel,
  writeRestartSentinel,
  type RestartSentinelPayload,
} from "./restart-sentinel.js";
import { generateSecureUuid } from "./secure-random.js";
import type { UpdateConfirmationTier, UpdateHandoverPhase } from "./update-handover.js";
import {
  commitUpdateRecoveryJournal,
  readUpdateRecoveryJournal,
  resolveUpdateRecoveryJournalPathFromSnapshot,
  resolveUpdateRecoveryJournalPath,
  rewriteUpdateRecoveryJournal,
  UPDATE_RECOVERY_LOCATOR_ENV,
  writeUpdateRecoveryJournal,
  writeUpdateRecoveryLocator,
} from "./update-recovery-journal.js";
import {
  buildUpdateRestartSentinelPayload,
  type UpdateRestartSentinelMeta,
} from "./update-restart-sentinel-payload.js";
import type { UpdateRunResult } from "./update-runner.js";

export const UPDATE_CONFIRMATION_PENDING_REASON = "update-confirmation-pending";
export const UPDATE_TRANSACTION_OWNER_LEASE_MS = 30_000;
const UPDATE_TRANSACTION_OWNER_LEASE_REFRESH_MS = 5_000;

const FORWARD_PHASE_RANK: Partial<Record<UpdateHandoverPhase, number>> = {
  verify: 0,
  snapshot: 1,
  swap: 2,
  restart: 3,
  healthy: 4,
  confirm: 5,
  complete: 6,
};

const ACTIVE_GATEWAY_PHASES = new Set<UpdateHandoverPhase>(["restart", "healthy", "confirm"]);
const OWNER_LEASE_PHASES = new Set<UpdateHandoverPhase>([
  "snapshot",
  "verify",
  "swap",
  ...ACTIVE_GATEWAY_PHASES,
]);

const TERMINAL_PHASES = new Set<UpdateHandoverPhase>(["complete", "rolled-back", "failed"]);

export type UpdateTransactionConfirmationStatus =
  | "pending"
  | "delivery-acked"
  | "human-confirmed"
  | "timed-out"
  | "failed";

export function isUpdateTransactionMarker(payload: RestartSentinelPayload): boolean {
  return (
    payload.kind === "update" &&
    typeof payload.stats?.handoffId === "string" &&
    typeof payload.stats.updatePhase === "string" &&
    typeof payload.stats.confirmationTier === "string" &&
    typeof payload.stats.confirmationStatus === "string"
  );
}

export function isActiveUpdateTransactionMarker(payload: RestartSentinelPayload): boolean {
  return (
    isUpdateTransactionMarker(payload) &&
    ACTIVE_GATEWAY_PHASES.has(payload.stats!.updatePhase!) &&
    !isUpdateTransactionConfirmed(payload) &&
    payload.stats?.confirmationStatus !== "failed" &&
    payload.stats?.confirmationStatus !== "timed-out"
  );
}

export type UpdateTransactionStartupDisposition = "normal" | "probation" | "blocked";

/** Decide whether a Gateway may start normally from the marker observed at server bootstrap. */
export function resolveUpdateTransactionStartupDisposition(
  payload: RestartSentinelPayload | null | undefined,
): UpdateTransactionStartupDisposition {
  if (!payload || !isUpdateTransactionMarker(payload)) {
    return "normal";
  }
  if (
    (isUpdateTransactionConfirmed(payload) && isUpdateTransactionProbationReleased(payload)) ||
    payload.stats?.updatePhase === "rolled-back"
  ) {
    return "normal";
  }
  if (isUpdateTransactionConfirmed(payload)) {
    return "probation";
  }
  return isActiveUpdateTransactionMarker(payload) ? "probation" : "blocked";
}

function canAdvanceUpdatePhase(current: UpdateHandoverPhase, next: UpdateHandoverPhase): boolean {
  if (current === "rolled-back") {
    // Package and state may be restored before service activation fails.
    return next === "failed";
  }
  if (TERMINAL_PHASES.has(current)) {
    return false;
  }
  if (current === "rolling-back") {
    return next === "rolling-back" || next === "rolled-back" || next === "failed";
  }
  if (next === "rolling-back" || next === "failed") {
    return true;
  }
  const currentRank = FORWARD_PHASE_RANK[current];
  const nextRank = FORWARD_PHASE_RANK[next];
  return currentRank !== undefined && nextRank !== undefined && nextRank >= currentRank;
}

export async function writeUpdateTransactionMarker(params: {
  result: UpdateRunResult;
  meta: UpdateRestartSentinelMeta & { handoffId: string };
  confirmationTier: UpdateConfirmationTier;
  phase?: UpdateHandoverPhase;
  rollback?: {
    packageRoot: string;
    retainedPackageRoot: string;
    stateSnapshotRoot: string;
    nodePath: string;
    recoveryJournalPath?: string;
  };
  env?: NodeJS.ProcessEnv;
}): Promise<RestartSentinel> {
  const payload = buildUpdateRestartSentinelPayload({ result: params.result, meta: params.meta });
  const recoveryJournalPath =
    params.rollback?.recoveryJournalPath ??
    resolveUpdateRecoveryJournalPath(params.env) ??
    (params.rollback
      ? resolveUpdateRecoveryJournalPathFromSnapshot(params.rollback.stateSnapshotRoot)
      : null);
  const markerPayload: RestartSentinelPayload = {
    ...payload,
    status: "skipped",
    stats: {
      ...payload.stats,
      handoffId: params.meta.handoffId,
      reason: UPDATE_CONFIRMATION_PENDING_REASON,
      updatePhase: params.phase ?? "restart",
      confirmationTier: params.confirmationTier,
      confirmationStatus: "pending",
      ...(params.confirmationTier === "human"
        ? { humanConfirmationChallenge: generateSecureUuid() }
        : {}),
      ...(params.rollback
        ? {
            packageRoot: params.rollback.packageRoot,
            retainedPackageRoot: params.rollback.retainedPackageRoot,
            stateSnapshotRoot: params.rollback.stateSnapshotRoot,
            updateNodePath: params.rollback.nodePath,
          }
        : {}),
      ...(OWNER_LEASE_PHASES.has(params.phase ?? "restart")
        ? { updateOwnerLeaseExpiresAtMs: Date.now() + UPDATE_TRANSACTION_OWNER_LEASE_MS }
        : {}),
    },
  };
  if (recoveryJournalPath) {
    await writeUpdateRecoveryJournal({
      filePath: recoveryJournalPath,
      handoffId: params.meta.handoffId,
      payload: markerPayload,
    });
    const locatorPath = params.env?.[UPDATE_RECOVERY_LOCATOR_ENV]?.trim();
    if (locatorPath) {
      await writeUpdateRecoveryLocator({
        filePath: locatorPath,
        handoffId: params.meta.handoffId,
        journalPath: recoveryJournalPath,
      });
    }
  }
  return await writeRestartSentinel(markerPayload, params.env);
}

async function rewriteMarker(params: {
  handoffId: string;
  env?: NodeJS.ProcessEnv;
  commitConfirmation?: boolean;
  rewrite: (payload: RestartSentinelPayload) => RestartSentinelPayload | null;
}): Promise<RestartSentinel | null> {
  const guardedRewrite = (payload: RestartSentinelPayload): RestartSentinelPayload | null => {
    if (!isUpdateTransactionMarker(payload) || payload.stats?.handoffId !== params.handoffId) {
      return null;
    }
    return params.rewrite(payload);
  };
  const explicitRecoveryJournalPath = resolveUpdateRecoveryJournalPath(params.env);
  // Validate the out-of-state recovery authority before touching SQLite. A
  // candidate migration may have made the live database impossible to open.
  if (explicitRecoveryJournalPath) {
    await readUpdateRecoveryJournal(explicitRecoveryJournalPath);
  }
  const current = await readRestartSentinel(params.env).catch(() => null);
  const recoveryJournalPath =
    explicitRecoveryJournalPath ??
    (current?.payload.stats?.stateSnapshotRoot
      ? resolveUpdateRecoveryJournalPathFromSnapshot(current.payload.stats.stateSnapshotRoot)
      : null) ??
    null;
  if (current && isUpdateTransactionConfirmed(current.payload)) {
    if (recoveryJournalPath) {
      // SQLite confirmation is irrevocable. Heal an interrupted staged journal
      // before any stale lease, timeout, or rollback writer can consult it.
      await commitUpdateRecoveryJournal({
        filePath: recoveryJournalPath,
        handoffId: params.handoffId,
        payload: current.payload,
      });
    }
    if (!guardedRewrite(current.payload)) {
      return null;
    }
  }
  const journal = recoveryJournalPath
    ? await rewriteUpdateRecoveryJournal({
        filePath: recoveryJournalPath,
        handoffId: params.handoffId,
        rewrite: guardedRewrite,
        stageConfirmation: params.commitConfirmation,
      })
    : null;
  if (recoveryJournalPath && !journal) {
    return null;
  }
  let stateWriteFailed = false;
  try {
    const updated = await rewriteRestartSentinel(guardedRewrite, params.env);
    if (updated) {
      if (recoveryJournalPath && params.commitConfirmation) {
        await commitUpdateRecoveryJournal({
          filePath: recoveryJournalPath,
          handoffId: params.handoffId,
          payload: updated.payload,
        });
      }
      return updated;
    }
  } catch (error) {
    if (!journal) {
      throw error;
    }
    stateWriteFailed = true;
  }
  if (params.commitConfirmation && journal) {
    throw new Error("update confirmation journal staged but state marker did not commit");
  }
  // A null SQLite rewrite is an authoritative rejected transition, including
  // a race with confirmation. Journal-only fallback is reserved for an
  // actually unreadable state store.
  return stateWriteFailed && journal
    ? { version: 1, revision: 0, payload: journal.committedPayload }
    : null;
}

export async function advanceUpdateTransactionMarker(params: {
  handoffId: string;
  phase: UpdateHandoverPhase;
  rollbackOwner?: string;
  result?: UpdateRunResult;
  confirmationStatus?: UpdateTransactionConfirmationStatus;
  reason?: string;
  status?: "ok" | "error" | "skipped";
  env?: NodeJS.ProcessEnv;
}): Promise<RestartSentinel | null> {
  return await rewriteMarker({
    handoffId: params.handoffId,
    env: params.env,
    rewrite: (payload) => {
      const currentPhase = payload.stats?.updatePhase;
      const rollbackOwner = payload.stats?.updateRollbackOwner;
      const resultStats = params.result
        ? buildUpdateRestartSentinelPayload({
            result: params.result,
            meta: { handoffId: params.handoffId },
          }).stats
        : null;
      if (
        isUpdateTransactionConfirmed(payload) &&
        currentPhase === "confirm" &&
        params.phase === "confirm"
      ) {
        // Gateway delivery can confirm between the updater's healthy and
        // confirm writes. Treat that cross-process race as already complete.
        return payload;
      }
      if (isUpdateTransactionConfirmed(payload) && params.phase !== "complete") {
        // Confirmation is the commit boundary. Stale failure paths must not
        // turn an acknowledged update back into a rollback candidate.
        return null;
      }
      if (!currentPhase || !canAdvanceUpdatePhase(currentPhase, params.phase)) {
        return null;
      }
      if (
        rollbackOwner &&
        (currentPhase === "rolling-back" ||
          currentPhase === "rolled-back" ||
          currentPhase === "failed") &&
        rollbackOwner !== params.rollbackOwner
      ) {
        return null;
      }
      return {
        ...payload,
        ...(params.status ? { status: params.status } : {}),
        stats: {
          ...payload.stats,
          ...resultStats,
          updatePhase: params.phase,
          ...(params.confirmationStatus ? { confirmationStatus: params.confirmationStatus } : {}),
          ...(params.reason ? { reason: params.reason } : {}),
        },
      };
    },
  });
}

export async function refreshUpdateTransactionOwnerLease(params: {
  handoffId: string;
  rollbackOwner?: string;
  leaseMs?: number;
  env?: NodeJS.ProcessEnv;
}): Promise<RestartSentinel | null> {
  return await rewriteMarker({
    handoffId: params.handoffId,
    env: params.env,
    rewrite: (payload) => {
      const ownsRollback =
        payload.stats?.updatePhase === "rolling-back" &&
        payload.stats.updateRollbackOwner === params.rollbackOwner;
      const ownsForwardPhase =
        isUpdateTransactionMarker(payload) &&
        OWNER_LEASE_PHASES.has(payload.stats!.updatePhase!) &&
        !isUpdateTransactionConfirmed(payload) &&
        payload.stats?.confirmationStatus !== "failed" &&
        payload.stats?.confirmationStatus !== "timed-out";
      if (!ownsForwardPhase && !ownsRollback) {
        return null;
      }
      return {
        ...payload,
        stats: {
          ...payload.stats,
          updateOwnerLeaseExpiresAtMs:
            Date.now() + (params.leaseMs ?? UPDATE_TRANSACTION_OWNER_LEASE_MS),
        },
      };
    },
  });
}

export async function claimExpiredUpdateTransactionOwner(params: {
  handoffId: string;
  rollbackOwner: string;
  now?: number;
  env?: NodeJS.ProcessEnv;
}): Promise<RestartSentinel | null> {
  return await claimUpdateTransactionRollback({
    handoffId: params.handoffId,
    rollbackOwner: params.rollbackOwner,
    reason: "update orchestrator lease expired",
    confirmationStatus: "timed-out",
    requireExpiredLease: true,
    leaseMs: 0,
    now: params.now,
    env: params.env,
  });
}

/** Claim exclusive ownership before touching retained package or state files. */
export async function claimUpdateTransactionRollback(params: {
  handoffId: string;
  rollbackOwner: string;
  reason: string;
  confirmationStatus?: "timed-out" | "failed";
  requireExpiredLease?: boolean;
  leaseMs?: number;
  now?: number;
  env?: NodeJS.ProcessEnv;
}): Promise<RestartSentinel | null> {
  const now = params.now ?? Date.now();
  return await rewriteMarker({
    handoffId: params.handoffId,
    env: params.env,
    rewrite: (payload) => {
      if (isUpdateTransactionConfirmed(payload)) {
        return null;
      }
      const phase = payload.stats?.updatePhase;
      if (!phase || phase === "complete" || phase === "rolled-back") {
        return null;
      }
      const currentOwner = payload.stats?.updateRollbackOwner;
      const leaseExpiresAt = payload.stats?.updateOwnerLeaseExpiresAtMs;
      if (
        (phase === "rolling-back" || phase === "failed") &&
        currentOwner !== params.rollbackOwner
      ) {
        if (typeof leaseExpiresAt === "number" && leaseExpiresAt > now) {
          return null;
        }
      } else if (
        params.requireExpiredLease &&
        OWNER_LEASE_PHASES.has(phase) &&
        typeof leaseExpiresAt === "number" &&
        leaseExpiresAt > now
      ) {
        return null;
      }
      return {
        ...payload,
        status: "error",
        stats: {
          ...payload.stats,
          updatePhase: "rolling-back",
          updateRollbackOwner: params.rollbackOwner,
          updateOwnerLeaseExpiresAtMs: now + (params.leaseMs ?? UPDATE_TRANSACTION_OWNER_LEASE_MS),
          confirmationStatus:
            payload.stats?.confirmationStatus === "timed-out"
              ? "timed-out"
              : (params.confirmationStatus ?? "failed"),
          reason: params.reason,
        },
      };
    },
  });
}

export async function startUpdateTransactionOwnerLease(params: {
  handoffId: string;
  rollbackOwner?: string;
  env?: NodeJS.ProcessEnv;
  leaseMs?: number;
  refreshMs?: number;
  onError?: (error: unknown) => void;
}): Promise<() => Promise<void>> {
  let stopped = false;
  let inFlight: Promise<unknown> | null = null;
  const initial = await refreshUpdateTransactionOwnerLease(params);
  if (!initial) {
    throw new Error("update transaction owner lease is unavailable");
  }
  const refresh = async () => {
    if (stopped || inFlight) {
      return;
    }
    inFlight = refreshUpdateTransactionOwnerLease(params).catch((error: unknown) => {
      params.onError?.(error);
    });
    await inFlight;
    inFlight = null;
  };
  const timer = setInterval(
    () => void refresh(),
    params.refreshMs ?? UPDATE_TRANSACTION_OWNER_LEASE_REFRESH_MS,
  );
  timer.unref?.();
  return async () => {
    stopped = true;
    clearInterval(timer);
    await inFlight;
  };
}

export async function markUpdateTransactionDeliveryAck(params: {
  handoffId: string;
  env?: NodeJS.ProcessEnv;
}): Promise<RestartSentinel | null> {
  return await rewriteMarker({
    ...params,
    commitConfirmation: true,
    rewrite: (payload) => {
      if (
        payload.stats?.confirmationStatus === "delivery-acked" &&
        payload.stats.updatePhase === "confirm"
      ) {
        return payload;
      }
      if (
        payload.stats?.confirmationStatus !== "pending" ||
        (payload.stats.updatePhase !== "healthy" && payload.stats.updatePhase !== "confirm")
      ) {
        return null;
      }
      return {
        ...payload,
        stats: {
          ...payload.stats,
          updatePhase: "confirm",
          confirmationStatus: "delivery-acked",
        },
      };
    },
  });
}

/** Fence confirmation while a consumed channel callback enters both replay stores. */
export async function beginUpdateTransactionReplayAdmission(params: {
  handoffId: string;
  env?: NodeJS.ProcessEnv;
}): Promise<RestartSentinel | null> {
  return await rewriteMarker({
    ...params,
    rewrite: (payload) => {
      if (!isActiveUpdateTransactionMarker(payload)) {
        return null;
      }
      return {
        ...payload,
        stats: {
          ...payload.stats,
          updateReplayAdmissionsPending: (payload.stats?.updateReplayAdmissionsPending ?? 0) + 1,
        },
      };
    },
  });
}

/** Clear one replay-admission fence only after both durable queue writes exist. */
export async function completeUpdateTransactionReplayAdmission(params: {
  handoffId: string;
  env?: NodeJS.ProcessEnv;
}): Promise<RestartSentinel | null> {
  return await rewriteMarker({
    ...params,
    rewrite: (payload) => {
      const pending = payload.stats?.updateReplayAdmissionsPending ?? 0;
      if (!isActiveUpdateTransactionMarker(payload) || pending <= 0) {
        return null;
      }
      return {
        ...payload,
        stats: {
          ...payload.stats,
          updateReplayAdmissionsPending: pending - 1,
        },
      };
    },
  });
}

/** Reject confirmation so the detached owner enters rollback immediately. */
export async function markUpdateTransactionConfirmationFailed(params: {
  handoffId: string;
  reason: string;
  env?: NodeJS.ProcessEnv;
}): Promise<RestartSentinel | null> {
  return await advanceUpdateTransactionMarker({
    handoffId: params.handoffId,
    phase: "confirm",
    confirmationStatus: "failed",
    status: "error",
    reason: params.reason,
    env: params.env,
  });
}

export async function markUpdateTransactionHumanReply(params: {
  handoffId: string;
  sessionKey: string;
  channel: string;
  to?: string;
  accountId?: string;
  threadId?: string;
  confirmationChallenge: string;
  env?: NodeJS.ProcessEnv;
}): Promise<RestartSentinel | null> {
  return await rewriteMarker({
    handoffId: params.handoffId,
    env: params.env,
    commitConfirmation: true,
    rewrite: (payload) => {
      if (
        payload.stats?.confirmationTier !== "human" ||
        (payload.stats.confirmationStatus !== "delivery-acked" &&
          payload.stats.confirmationStatus !== "human-confirmed") ||
        payload.sessionKey !== params.sessionKey ||
        payload.deliveryContext?.channel !== params.channel ||
        payload.deliveryContext?.to !== params.to ||
        normalizeAccountId(payload.deliveryContext?.accountId) !==
          normalizeAccountId(params.accountId) ||
        payload.threadId !== params.threadId ||
        payload.stats.humanConfirmationChallenge !== params.confirmationChallenge
      ) {
        return null;
      }
      if (payload.stats.confirmationStatus === "human-confirmed") {
        return payload;
      }
      return {
        ...payload,
        stats: { ...payload.stats, updatePhase: "confirm", confirmationStatus: "human-confirmed" },
      };
    },
  });
}

export function isUpdateTransactionConfirmed(payload: RestartSentinelPayload): boolean {
  if (!isUpdateTransactionMarker(payload)) {
    return false;
  }
  return payload.stats?.confirmationTier === "human"
    ? payload.stats.confirmationStatus === "human-confirmed"
    : payload.stats?.confirmationStatus === "delivery-acked";
}

/** Confirmation is final only after candidate replay claims are durably released. */
export function isUpdateTransactionProbationReleased(payload: RestartSentinelPayload): boolean {
  return (
    isUpdateTransactionConfirmed(payload) &&
    typeof payload.stats?.updateProbationReleasedAtMs === "number"
  );
}

export async function markUpdateTransactionProbationReleased(params: {
  handoffId: string;
  env?: NodeJS.ProcessEnv;
}): Promise<RestartSentinel | null> {
  return await rewriteMarker({
    ...params,
    // Stage the journal, commit SQLite, then commit the journal. Cleanup must
    // never observe release unless both recovery authorities can reproduce it.
    commitConfirmation: true,
    rewrite: (payload) => {
      if (!isUpdateTransactionConfirmed(payload)) {
        return null;
      }
      if (isUpdateTransactionProbationReleased(payload)) {
        return payload;
      }
      return {
        ...payload,
        stats: { ...payload.stats, updateProbationReleasedAtMs: Date.now() },
      };
    },
  });
}

function isUpdateTransactionConfirmationFailed(payload: RestartSentinelPayload): boolean {
  return (
    isUpdateTransactionMarker(payload) &&
    (payload.stats?.confirmationStatus === "failed" ||
      payload.stats?.confirmationStatus === "timed-out")
  );
}

export async function waitForUpdateTransactionConfirmation(params: {
  handoffId: string;
  rollbackOwner: string;
  timeoutMs: number;
  pollMs?: number;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<boolean> {
  const now = params.now ?? Date.now;
  const sleep =
    params.sleep ??
    ((ms) =>
      new Promise((resolve) => {
        setTimeout(resolve, ms);
      }));
  const deadline = now() + params.timeoutMs;
  while (now() < deadline) {
    const recoveryJournalPath = resolveUpdateRecoveryJournalPath(params.env);
    const journal = recoveryJournalPath
      ? await readUpdateRecoveryJournal(recoveryJournalPath)
      : null;
    if (
      journal?.handoffId === params.handoffId &&
      isUpdateTransactionProbationReleased(journal.committedPayload)
    ) {
      return true;
    }
    if (
      journal?.handoffId === params.handoffId &&
      isUpdateTransactionConfirmationFailed(journal.committedPayload)
    ) {
      return false;
    }
    const marker = await readRestartSentinel(params.env).catch(() => null);
    if (
      !recoveryJournalPath &&
      marker &&
      marker.payload.stats?.handoffId === params.handoffId &&
      isUpdateTransactionProbationReleased(marker.payload)
    ) {
      return true;
    }
    if (
      !recoveryJournalPath &&
      marker?.payload.stats?.handoffId === params.handoffId &&
      isUpdateTransactionConfirmationFailed(marker.payload)
    ) {
      return false;
    }
    await sleep(Math.min(params.pollMs ?? 1_000, Math.max(1, deadline - now())));
  }
  const claimed = await claimUpdateTransactionRollback({
    handoffId: params.handoffId,
    rollbackOwner: params.rollbackOwner,
    reason: "update confirmation timed out",
    confirmationStatus: "timed-out",
    env: params.env,
  });
  if (!claimed) {
    // Confirmation is irrevocable even when the Gateway still has to release
    // probationary queue claims. The user-facing timeout is satisfied; keep
    // the detached owner alive until that local closeout becomes durable.
    for (;;) {
      const recoveryJournalPath = resolveUpdateRecoveryJournalPath(params.env);
      const journal = recoveryJournalPath
        ? await readUpdateRecoveryJournal(recoveryJournalPath)
        : null;
      const payload = recoveryJournalPath
        ? journal?.handoffId === params.handoffId
          ? journal.committedPayload
          : null
        : ((await readRestartSentinel(params.env).catch(() => null))?.payload ?? null);
      if (payload?.stats?.handoffId === params.handoffId) {
        if (isUpdateTransactionProbationReleased(payload)) {
          return true;
        }
        if (isUpdateTransactionConfirmed(payload)) {
          await sleep(params.pollMs ?? 1_000);
          continue;
        }
      }
      return false;
    }
  }
  return false;
}

export async function clearUpdateTransactionMarker(params: {
  handoffId: string;
  env?: NodeJS.ProcessEnv;
}): Promise<boolean> {
  const marker = await readRestartSentinel(params.env);
  if (!marker || marker.payload.stats?.handoffId !== params.handoffId) {
    return false;
  }
  return await clearRestartSentinelIfRevision(marker.revision, params.env);
}
