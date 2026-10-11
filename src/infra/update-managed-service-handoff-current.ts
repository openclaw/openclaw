import { readControlPlaneUpdateSentinelMeta } from "./update-control-plane-sentinel.js";
import { resolveUpdateInstallRoot } from "./update-install-root.js";
import {
  createManagedHandoffLeaseStore,
  type ManagedHandoffLease,
} from "./update-managed-service-handoff-lease.js";
import type { ActiveManagedServiceUpdateHandoff } from "./update-managed-service-handoff-types.js";

export const activeManagedServiceUpdateHandoffs = new Map<
  string,
  ActiveManagedServiceUpdateHandoff
>();

/** A detached helper still shares the system unit's cgroup until it settles. */
export function waitForSystemServiceUpdateHandoffs(): Promise<void> | undefined {
  const updates = [...activeManagedServiceUpdateHandoffs.values()].filter(
    (owner) => owner.operatorRestartWarning && !owner.settled,
  );
  if (!updates.length) {
    return undefined;
  }
  return (async () => {
    await Promise.all(
      updates.map(async (owner) => {
        await owner.flight;
        await owner.closed;
        if (!owner.settled) {
          throw new Error("System-service updater settlement could not be confirmed.");
        }
      }),
    );
  })();
}

/** A transferred updater may manage its serving ancestor only under its current lease. */
export async function isCurrentManagedServiceUpdateHandoffProcess(params: {
  root: string;
  runId: string | undefined;
  env?: NodeJS.ProcessEnv;
  /** Retain the executor's admitted physical store through the sentinel await. */
  store?: ReturnType<typeof createManagedHandoffLeaseStore>;
}): Promise<boolean> {
  const env = params.env ?? process.env;
  if (env.OPENCLAW_UPDATE_RUN_HANDOFF !== "1" || !params.runId) {
    return false;
  }
  const meta = await readControlPlaneUpdateSentinelMeta(env);
  const root = resolveUpdateInstallRoot(params.root);
  if (
    meta?.runId !== params.runId ||
    !meta.handoffId ||
    !meta.root ||
    resolveUpdateInstallRoot(meta.root) !== root
  ) {
    return false;
  }
  const lease = readManagedServiceUpdateHandoffLease(root, undefined, params.store);
  const store = params.store ?? createManagedHandoffLeaseStore();
  return (
    lease?.owner === meta.handoffId &&
    lease.executor.pid === process.pid &&
    (store.isProcessIdentityCurrent(lease.executor) ||
      (process.connected && store.acceptParentBoundExecutor(lease)))
  );
}

export function readManagedServiceUpdateHandoffLease(
  root: string,
  stale?: ActiveManagedServiceUpdateHandoff,
  selectedStore?: ReturnType<typeof createManagedHandoffLeaseStore>,
): ManagedHandoffLease | null | undefined {
  const owner = stale ?? activeManagedServiceUpdateHandoffs.get(root);
  const store = selectedStore ?? (owner ? owner.leaseStore : createManagedHandoffLeaseStore());
  const result = store?.read(root);
  if (!store || result?.kind !== "current") {
    return result?.kind === "absent" ? null : undefined;
  }
  const lease = result.lease;
  if (
    stale?.handoffId === lease.owner &&
    JSON.stringify(stale.helper?.helper) === JSON.stringify(lease.helper) &&
    (lease.action.kind !== "update" || stale.helper?.payload === lease.payload) &&
    (lease.action.kind !== "triage" ||
      (stale.helper?.action.kind === "triage" &&
        JSON.stringify(stale.helper.action.lifetime) === JSON.stringify(lease.action.lifetime))) &&
    store.release(lease)
  ) {
    return null;
  }
  return lease;
}
