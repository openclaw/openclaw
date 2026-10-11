import type { DeliveryQueueStateContext } from "../infra/delivery-queue-state-context.js";
import type { RestartSentinel } from "../infra/restart-sentinel-store.js";
import { readRestartSentinel } from "../infra/restart-sentinel.js";
import { assertNoRetiredRestartSentinelFiles } from "../infra/state-migrations.restart-sentinel.js";
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
}) {
  if (params.shouldRun?.() === false) {
    return null;
  }
  const env = params.context.workerContext.environment;
  assertNoRetiredRestartSentinelFiles(env.OPENCLAW_STATE_DIR);
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
