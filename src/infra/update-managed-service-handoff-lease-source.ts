// Embedded into the sealed handoff script; shares its captured lease and command state.
export const MANAGED_HANDOFF_LEASE_SOURCE = String.raw`
function initialTriageAction() {
  return { kind: "triage", phase: "reserved", lifetime: { kind: "native", unit: params.serviceRecovery.unit, scope: params.scopeUnit, placement: { kind: "pending" } } };
}
function acquireManagedUpdateLease() {
  const result = leaseStore.acquire(params.updateLeaseKey, params.updateLeaseOwner,
    params.action === "triage" ? initialTriageAction() : { kind: "update" }, params.triageTransition);
  if (result.kind === "acquired") {
    managedUpdateLease = result.lease;
    if (params.action === "triage") nativePlacement = result.lease;
  }
  return { acquired: result.kind === "acquired", owner: result.owner };
}
function bindManagedUpdateLeaseToProcess(pid, expectedPayload, action, argv) {
  if (!managedUpdateLease || expectedPayload && managedUpdateLease.payload !== expectedPayload) return false;
  const next = leaseStore.bind(managedUpdateLease, pid, action, argv);
  if (!next) return false;
  managedUpdateLease = next;
  return true;
}
function hasManagedUpdateLease() { return managedUpdateLease && leaseStore.owns(managedUpdateLease); }
function ownsManagedUpdateLease() {
  return hasManagedUpdateLease() && (managedUpdateLease.executor.pid === process.pid ||
    (activeCommand?.pid === managedUpdateLease.executor.pid &&
      leaseStore.isProcessIdentityCurrent(managedUpdateLease.executor, activeCommand.exitCode === null && activeCommand.signalCode === null)));
}
function releaseManagedUpdateLease() {
  const lease = managedUpdateLease;
  if (!lease) return;
  try {
    if (lease.action.kind === "triage") leaseStore.settle(lease, "closing");
    else leaseStore.release(lease);
  } catch (error) { appendLog("managed handoff release failed: " + String(error)); }
  managedUpdateLease = null;
}
`.trim();
