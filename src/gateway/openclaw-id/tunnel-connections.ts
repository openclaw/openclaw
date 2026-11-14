// Run custody of OpenClaw ID tunnel connections (OCF-210, spec section 7). A run
// records the Gateway connection that started it, and ordinary runs survive their
// socket. Removing a member must still find those runs after the member disconnected,
// so every relayed connection is remembered with its authenticated device key W
// for as long as it is open or any run or queued input it started is unsettled.
// This module imports nothing: the Gateway's connection owner records into it.

type TunnelConnection = { peerKey: string; closed: AbortSignal };

/** Lists the connection ids that still own an unsettled (queued or running) run. */
export type RunOwnerConnections = () => ReadonlySet<string>;

const connections = new Map<string, TunnelConnection>();
let runOwners: RunOwnerConnections | undefined;

// Forgets closed connections whose runs have all settled. Until the run owner is
// published nothing closed is forgotten, so custody is never dropped early.
function prune(): void {
  if (!runOwners) {
    return;
  }
  let owners: ReadonlySet<string> | undefined;
  for (const [connId, entry] of connections) {
    if (!entry.closed.aborted) {
      continue;
    }
    owners ??= runOwners();
    if (!owners.has(connId)) {
      connections.delete(connId);
    }
  }
}

/** Publishes how to find connections that still own runs (the removal effects do this). */
export function setOpenClawIdRunOwnerConnections(next: RunOwnerConnections | undefined): void {
  runOwners = next;
}

/**
 * Records a connection relayed by the tunnel child for device key `peerKey`.
 * `closed` aborts when the connection retires.
 */
export function recordOpenClawIdTunnelConnection(
  connId: string,
  peerKey: string,
  closed: AbortSignal,
): void {
  prune();
  connections.set(connId, { peerKey, closed });
}

/** Every remembered connection (open, or closed with unsettled runs) of these device keys. */
export function openclawIdTunnelConnectionsOf(peerKeys: readonly string[]): string[] {
  prune();
  const ids: string[] = [];
  for (const [connId, entry] of connections) {
    if (peerKeys.includes(entry.peerKey)) {
      ids.push(connId);
    }
  }
  return ids;
}

/** Test seam: forgets every recorded connection and the run owner. */
export function resetOpenClawIdTunnelConnectionsForTest(): void {
  connections.clear();
  runOwners = undefined;
}
