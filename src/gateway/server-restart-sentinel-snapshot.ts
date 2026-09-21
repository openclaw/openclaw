import type { DeliveryQueueStateContext } from "../infra/delivery-queue-state-context.js";
import { readRestartSentinel, type RestartSentinelPayload } from "../infra/restart-sentinel.js";
import { isPendingControlPlaneUpdateRestartSentinel } from "../infra/update-control-plane-sentinel.js";
import { finalizeRestartUpdateRun } from "./server-restart-update-run.js";

export type PendingUpdateSentinelIdentity = { runId: string; handoffId?: string };

function matchesPendingUpdateSentinel(
  payload: RestartSentinelPayload,
  pending: PendingUpdateSentinelIdentity,
): boolean {
  return (
    payload.kind === "update" &&
    payload.stats?.runId === pending.runId &&
    payload.stats.handoffId === pending.handoffId
  );
}

export async function readRestartSentinelStartupSnapshot(params: {
  context: DeliveryQueueStateContext;
  pendingUpdate?: PendingUpdateSentinelIdentity;
}) {
  const env = params.context.workerContext.environment;
  let sentinel = await readRestartSentinel(env);
  if (!sentinel) {
    return null;
  }
  const payload = sentinel.payload;
  if (params.pendingUpdate && !matchesPendingUpdateSentinel(payload, params.pendingUpdate)) {
    return null;
  }
  const updateRun =
    payload.kind === "update"
      ? await finalizeRestartUpdateRun(payload, false, params.context)
      : undefined;
  const pendingUpdate =
    isPendingControlPlaneUpdateRestartSentinel(payload) && payload.stats?.runId
      ? { runId: payload.stats.runId, handoffId: payload.stats.handoffId }
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
    if (
      current &&
      current.revision !== sentinel.revision &&
      pendingUpdate &&
      matchesPendingUpdateSentinel(current.payload, pendingUpdate) &&
      !isPendingControlPlaneUpdateRestartSentinel(current.payload)
    ) {
      sentinel = current;
    } else if (
      current?.revision !== sentinel.revision &&
      (!current || !pendingUpdate || !matchesPendingUpdateSentinel(current.payload, pendingUpdate))
    ) {
      pendingSnapshotSuperseded = true;
    }
  }
  return { sentinel, updateRun, pendingUpdate, pendingSnapshotSuperseded };
}
