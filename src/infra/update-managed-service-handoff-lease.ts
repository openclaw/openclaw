// Preloaded adapter for the same typed owner sealed into the native helper.
import path from "node:path";
import { resolveServiceManagerEnv } from "../daemon/service-process-env.js";
import { resolvePreferredOpenClawTmpDir } from "./tmp-openclaw-dir.js";
import { createManagedHandoffLeaseRuntime } from "./update-managed-service-handoff-lease-runtime.js";
import type { ManagedHandoffLease } from "./update-managed-service-handoff-lease-state.js";
export type { ManagedHandoffLease } from "./update-managed-service-handoff-lease-state.js";

export function resolveManagedUpdateLeaseDatabasePath(): string {
  return path.join(resolvePreferredOpenClawTmpDir(), "managed-update-handoffs.sqlite");
}

export function createManagedHandoffLeaseStore() {
  return createManagedHandoffLeaseRuntime({
    databasePath: resolveManagedUpdateLeaseDatabasePath(),
    serviceManagerEnv: resolveServiceManagerEnv(),
  });
}

export function readManagedServiceUpdateHandoffLease(
  root: string,
  stale?: { handoffId: string; helper?: ManagedHandoffLease },
): ManagedHandoffLease | null | undefined {
  const store = createManagedHandoffLeaseStore();
  const result = store.read(root);
  if (result.kind !== "current") {
    return result.kind === "absent" ? null : undefined;
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

/** Native identity probes use the same projected environment as staged control. */
export function readManagedHandoffProcessStartTime(pid: number): number | null {
  const value = createManagedHandoffLeaseStore().readProcessStartIdentity(pid);
  return value === null ? null : Number(value);
}
