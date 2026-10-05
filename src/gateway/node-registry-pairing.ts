import { racePromiseWithAbortSignal } from "../infra/abort-signal.js";
import type { PairedDeviceNodeBinding } from "../infra/device-pairing-node-state.js";
import { ABSOLUTE_DEADLINE_EXPIRED, awaitWithinDeadline } from "../utils/absolute-deadline.js";
import { sleep } from "../utils/sleep.js";
import type { NodeSession } from "./node-session.types.js";

export type NodePairingLease = {
  session: NodeSession & { pairingIdentity: string };
  nodeId: string;
  connId: string;
  binding: PairedDeviceNodeBinding;
};

export type NodePairingLeaseResolution<TSession = NodePairingLease["session"]> =
  | { status: "current"; session: TSession }
  | { status: "stale"; presenceInvalidated: boolean }
  | { status: "unavailable" };
export type NodePairingLeaseDispatchResult<TSession> =
  | NodePairingLeaseResolution<TSession>
  | typeof ABSOLUTE_DEADLINE_EXPIRED;

/** A private worker command may reread transiently unavailable authority once, before dispatch. */
export async function resolvePairingLeaseBeforeDispatch<TSession>(
  resolve: () => Promise<NodePairingLeaseResolution<TSession>>,
  options: { deadlineAtMs?: number; signal?: AbortSignal; retryUnavailable: boolean },
): Promise<NodePairingLeaseDispatchResult<TSession>> {
  for (let attempt = 0; ; attempt++) {
    const resolution = await awaitWithinDeadline(
      () => racePromiseWithAbortSignal(resolve(), options.signal),
      options.deadlineAtMs,
      () => performance.now(),
    );
    if (
      resolution !== ABSOLUTE_DEADLINE_EXPIRED &&
      resolution.status === "unavailable" &&
      options.retryUnavailable &&
      attempt === 0
    ) {
      const wait = await awaitWithinDeadline(
        () => sleep(250, options.signal),
        options.deadlineAtMs,
        () => performance.now(),
      );
      if (wait !== ABSOLUTE_DEADLINE_EXPIRED) {
        continue;
      }
      return ABSOLUTE_DEADLINE_EXPIRED;
    }
    return resolution;
  }
}

export function pairingBindingForSession(node: {
  pairingIdentity: string;
  pairingGeneration?: string;
}): PairedDeviceNodeBinding {
  return {
    identity: node.pairingIdentity,
    ...(node.pairingGeneration ? { generation: node.pairingGeneration } : {}),
  };
}

export function pairingStateMatchesBinding(
  binding: PairedDeviceNodeBinding,
  current: PairedDeviceNodeBinding | undefined,
): boolean {
  if (!current) {
    return false;
  }
  if (binding.identity !== current.identity) {
    return false;
  }
  return !binding.generation || binding.generation === current.generation;
}

export function resolvePublishedPairingCurrentness(
  node: { nodeId: string; pairingIdentity?: string; pairingGeneration?: string },
  isPairingStateCurrent:
    | ((nodeId: string, expected: PairedDeviceNodeBinding) => boolean)
    | undefined,
): "current" | "stale" | "unavailable" {
  if (!isPairingStateCurrent) {
    return "current";
  }
  try {
    return node.pairingIdentity &&
      isPairingStateCurrent(node.nodeId, {
        identity: node.pairingIdentity,
        ...(node.pairingGeneration ? { generation: node.pairingGeneration } : {}),
      })
      ? "current"
      : "stale";
  } catch {
    return "unavailable";
  }
}

export function isPublishedPairingCurrent(
  node: { nodeId: string; pairingIdentity?: string; pairingGeneration?: string },
  isPairingStateCurrent:
    | ((nodeId: string, expected: PairedDeviceNodeBinding) => boolean)
    | undefined,
): boolean {
  return resolvePublishedPairingCurrentness(node, isPairingStateCurrent) === "current";
}
