import type { DeliveryQueueStateContext } from "../infra/delivery-queue-state-context.js";
import type { RestartSentinel } from "../infra/restart-sentinel-store.js";
import { readRestartSentinel } from "../infra/restart-sentinel.js";
import { importLegacyUpdateRestartSentinel } from "../infra/state-migrations.restart-sentinel-runtime.js";
import { isPendingControlPlaneUpdateRestartSentinel } from "../infra/update-control-plane-sentinel.js";
import { finalizeRestartUpdateRun } from "./server-restart-update-run.js";

export type PendingUpdateSentinelIdentity =
  | { kind: "run"; runId: string; handoffId?: string }
  | { kind: "legacy"; revision: number; handoffId: string };

function matchesPendingUpdateSentinel(
  sentinel: RestartSentinel,
  pending: PendingUpdateSentinelIdentity,
): boolean {
  const { payload } = sentinel;
  return pending.kind === "legacy"
    ? sentinel.revision === pending.revision &&
        payload.kind === "update" &&
        !payload.stats?.runId &&
        payload.stats?.handoffId === pending.handoffId
    : payload.kind === "update" &&
        payload.stats?.runId === pending.runId &&
        payload.stats.handoffId === pending.handoffId;
}

export async function readRestartSentinelStartupSnapshot(params: {
  context: DeliveryQueueStateContext;
  pendingUpdate?: PendingUpdateSentinelIdentity;
  shouldRun?: () => boolean;
  warn?: (message: string) => void;
  trackImport?: (work: Promise<unknown>) => void;
}) {
  if (params.shouldRun?.() === false) {
    return null;
  }
  const env = params.context.workerContext.environment;
  let sentinel = await readRestartSentinel(env);
  if (params.shouldRun?.() === false) {
    return null;
  }
  if (
    params.pendingUpdate &&
    (!sentinel || !matchesPendingUpdateSentinel(sentinel, params.pendingUpdate))
  ) {
    return null;
  }
  if (params.shouldRun) {
    const importing = importLegacyUpdateRestartSentinel({
      context: params.context.workerContext,
      shouldRun: params.shouldRun,
      ...(sentinel ? { expectedRevision: sentinel.revision } : {}),
    });
    params.trackImport?.(importing);
    const imported = await importing;
    if (!params.shouldRun()) {
      return null;
    }
    if (imported.superseded) {
      return null;
    }
    for (const warning of imported.warnings) {
      params.warn?.(warning);
    }
    if (imported.importedRevision !== undefined) {
      sentinel = await readRestartSentinel(env);
      // Import custody cannot consume a native notification published after its commit.
      if (!sentinel || sentinel.revision !== imported.importedRevision) {
        return null;
      }
    } else if (sentinel && (imported.changes.length > 0 || imported.warnings.length > 0)) {
      const current = await readRestartSentinel(env);
      if (!current || current.revision !== sentinel.revision) {
        return null;
      }
    }
  }
  if (!sentinel || params.shouldRun?.() === false) {
    return null;
  }
  const payload = sentinel.payload;
  const updateRun =
    payload.kind === "update"
      ? await finalizeRestartUpdateRun(payload, false, params.context)
      : undefined;
  if (params.shouldRun?.() === false) {
    return null;
  }
  const pendingUpdate: PendingUpdateSentinelIdentity | undefined =
    isPendingControlPlaneUpdateRestartSentinel(payload)
      ? payload.stats?.runId
        ? { kind: "run", runId: payload.stats.runId, handoffId: payload.stats.handoffId }
        : payload.stats?.handoffId
          ? { kind: "legacy", revision: sentinel.revision, handoffId: payload.stats.handoffId }
          : undefined
      : undefined;
  let pendingSnapshotSuperseded = false;
  if (
    isPendingControlPlaneUpdateRestartSentinel(payload) &&
    updateRun &&
    updateRun.status !== "running"
  ) {
    // The helper can publish its terminal marker and ledger while the pending
    // snapshot is in flight. Reconcile before deriving revision-keyed work.
    const current = await readRestartSentinel(env);
    if (params.shouldRun?.() === false) {
      return null;
    }
    if (
      current &&
      current.revision !== sentinel.revision &&
      pendingUpdate &&
      matchesPendingUpdateSentinel(current, pendingUpdate) &&
      !isPendingControlPlaneUpdateRestartSentinel(current.payload)
    ) {
      sentinel = current;
    } else if (
      current?.revision !== sentinel.revision &&
      (!current || !pendingUpdate || !matchesPendingUpdateSentinel(current, pendingUpdate))
    ) {
      pendingSnapshotSuperseded = true;
    }
  }
  return { sentinel, updateRun, pendingUpdate, pendingSnapshotSuperseded };
}
