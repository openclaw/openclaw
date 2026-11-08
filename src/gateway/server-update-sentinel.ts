import { captureDeliveryQueueStateContext } from "../infra/delivery-queue-state-context.js";
import {
  finalizeUpdateRestartSentinelRunningVersion,
  readRestartSentinelSnapshot,
  type RestartSentinelPayload,
} from "../infra/restart-sentinel.js";
import {
  currentUpdateCheckLifecycle,
  type UpdateCheckLifecycle,
} from "../infra/update-check-lifecycle.js";
import { isPendingControlPlaneUpdateRestartSentinel } from "../infra/update-control-plane-sentinel.js";
import { freezeJsonSnapshot } from "../shared/immutable-data.js";

let latestUpdateRestartSentinel: RestartSentinelPayload | null = null;
let refreshTail = Promise.resolve();
const preparations = new WeakMap<UpdateCheckLifecycle, Promise<void>>();

/** Startup and reconnects join one preparation; update producers publish later snapshots. */
export async function prepareLatestUpdateRestartSentinel(
  env?: NodeJS.ProcessEnv,
  lifecycle = currentUpdateCheckLifecycle(),
): Promise<RestartSentinelPayload | null> {
  let preparation = preparations.get(lifecycle);
  if (!preparation) {
    preparation = lifecycle.run(async (signal) => {
      await refreshLatestUpdateRestartSentinel(env, () => lifecycle.isCurrent() && !signal.aborted);
    });
    preparations.set(lifecycle, preparation);
    void preparation.catch(() => preparations.delete(lifecycle));
  }
  await preparation;
  return getLatestUpdateRestartSentinel();
}

export function refreshLatestUpdateRestartSentinel(
  env: NodeJS.ProcessEnv = captureDeliveryQueueStateContext().workerContext.environment,
  isCurrent: () => boolean = () => true,
): Promise<RestartSentinelPayload | null> {
  // Explicit refreshes read in order; reports must not join an earlier owner's snapshot.
  const refresh = refreshTail.then(async () => {
    if (!isCurrent()) {
      return latestUpdateRestartSentinel;
    }
    const previous = latestUpdateRestartSentinel;
    const { sentinel: current } = await readRestartSentinelSnapshot(env);
    if (!isCurrent()) {
      return latestUpdateRestartSentinel;
    }
    const sentinel =
      !current || isPendingControlPlaneUpdateRestartSentinel(current.payload)
        ? current
        : ((await finalizeUpdateRestartSentinelRunningVersion(undefined, env)) ?? current);
    // A late read must not replace a newer producer publication or a successor Gateway.
    if (
      sentinel?.payload.kind === "update" &&
      latestUpdateRestartSentinel === previous &&
      isCurrent()
    ) {
      latestUpdateRestartSentinel = freezeJsonSnapshot(sentinel.payload);
    }
    return latestUpdateRestartSentinel;
  });
  refreshTail = refresh.then(
    () => undefined,
    () => undefined,
  );
  return refresh;
}

/** Readers share an immutable snapshot; publication preserves previously returned generations. */
export function getLatestUpdateRestartSentinel(): RestartSentinelPayload | null {
  return latestUpdateRestartSentinel;
}

export function recordLatestUpdateRestartSentinel(payload: RestartSentinelPayload): void {
  latestUpdateRestartSentinel = freezeJsonSnapshot(structuredClone(payload));
}
