import type { WorkerProvider } from "../../plugins/types.js";
import type { WorkerProviderLifecycleOptions } from "./provider-lifecycle.types.js";
import { requireWorkerLeaseStatus } from "./service-validation.js";
import type { WorkerEnvironmentRecord } from "./store.js";

export function createDedicatedNodeLeaseAttestations(
  options: Pick<
    WorkerProviderLifecycleOptions,
    "store" | "isStopping" | "callProvider" | "saveError"
  >,
  assertCurrent: (record: WorkerEnvironmentRecord) => unknown,
) {
  const { store } = options;
  // Narrow preview admission requires an explicit provider fact. Persisted sharedHost
  // also contains legacy omission defaults, so it cannot independently grant this access.
  const dedicatedNodeLeases = new Map<
    string,
    { leaseId: string; nodeDeviceId: string; ownerEpoch: number; controller: AbortController }
  >();
  const retireDedicatedNodeLease = (environmentId: string) => {
    const proof = dedicatedNodeLeases.get(environmentId);
    dedicatedNodeLeases.delete(environmentId);
    proof?.controller.abort(new Error("Dedicated worker lease qualification ended"));
  };
  const noteDedicatedNodeLease = (record: WorkerEnvironmentRecord, explicitDedicated: boolean) => {
    assertCurrent(record);
    const prior = dedicatedNodeLeases.get(record.environmentId);
    if (
      explicitDedicated &&
      record.sharedHost === false &&
      prior &&
      prior.leaseId === record.leaseId &&
      prior.nodeDeviceId === record.nodeDeviceId &&
      prior.ownerEpoch === record.ownerEpoch
    ) {
      return;
    }
    retireDedicatedNodeLease(record.environmentId);
    if (explicitDedicated && record.leaseId && record.nodeDeviceId && record.sharedHost === false) {
      dedicatedNodeLeases.set(record.environmentId, {
        leaseId: record.leaseId,
        nodeDeviceId: record.nodeDeviceId,
        ownerEpoch: record.ownerEpoch,
        controller: new AbortController(),
      });
    }
  };
  const getDedicatedNodeLeaseSignal = (environmentId: string): AbortSignal | undefined => {
    const proof = dedicatedNodeLeases.get(environmentId);
    const current = store.get(environmentId);
    return !options.isStopping() &&
      proof &&
      current &&
      current.leaseId === proof.leaseId &&
      current.nodeDeviceId === proof.nodeDeviceId &&
      current.ownerEpoch === proof.ownerEpoch &&
      current.sharedHost === false &&
      current.destroyRequestedAtMs === null &&
      ["ready", "idle", "attached"].includes(current.state)
      ? proof.controller.signal
      : undefined;
  };
  const unsubscribeDedicatedLeaseRevocation = store.onCredentialRevoked((environmentId) => {
    const proof = dedicatedNodeLeases.get(environmentId);
    // Delayed notifications identify an environment, not an owner. A current
    // successor proof must survive notification of its predecessor's revocation.
    if (
      proof &&
      (!store.getCredential(environmentId) ||
        getDedicatedNodeLeaseSignal(environmentId) !== proof.controller.signal)
    ) {
      retireDedicatedNodeLease(environmentId);
    }
  });

  return {
    async reconcileSharedHost(
      initialRecord: WorkerEnvironmentRecord,
      leaseId: string,
      inspection: { sharedHost?: boolean; explicitlyDedicated: boolean },
      stopOwner: (record: WorkerEnvironmentRecord) => Promise<WorkerEnvironmentRecord>,
    ) {
      let record = initialRecord;
      const sharedHost = inspection.sharedHost === true;
      if (record.sharedHost !== null && record.sharedHost !== sharedHost) {
        // Workspace actions capture isolation at tunnel creation. Fence the old actions before
        // committing a provider-owned change so no reconciliation can use stale host scope.
        record = await stopOwner(record);
      }
      record = await store.reconcileSharedHost({
        environmentId: record.environmentId,
        state: record.state,
        leaseId,
        sharedHost,
      });
      noteDedicatedNodeLease(record, inspection.explicitlyDedicated);
      return record;
    },
    async inspect(
      record: WorkerEnvironmentRecord,
      provider: WorkerProvider,
      lease: Parameters<WorkerProvider["inspect"]>[0],
    ) {
      const inspection = await options
        .callProvider(record.environmentId, () => provider.inspect(lease))
        .then((result) => ({
          ...requireWorkerLeaseStatus(result),
          explicitlyDedicated: result.status === "active" && result.sharedHost === false,
        }))
        .catch(async (error: unknown) => {
          await options.saveError(record, error);
          return undefined;
        });
      if (inspection) {
        assertCurrent(record);
        if (inspection.status !== "active") {
          retireDedicatedNodeLease(record.environmentId);
        }
      }
      return inspection;
    },
    note: noteDedicatedNodeLease,
    retire: retireDedicatedNodeLease,
    signal: getDedicatedNodeLeaseSignal,
    clear() {
      unsubscribeDedicatedLeaseRevocation();
      for (const environmentId of dedicatedNodeLeases.keys()) {
        retireDedicatedNodeLease(environmentId);
      }
    },
  };
}
