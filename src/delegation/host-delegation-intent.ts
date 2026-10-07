/**
 * Host-owned delegation intent.
 *
 * The Host — and only the Host — decides that a turn or run has been delegated
 * to an external/delegate owner. That decision is represented by this binding,
 * which is minted by Host code and proven unforgeable by object identity: model
 * output, plugin arguments, tool arguments, and arbitrary strings can build an
 * object with the same fields but they cannot register it in the Host's
 * WeakSet, so they can never present a delegation intent the Host will accept.
 *
 * Delegation is never inferred from sessionKey, user, workspace, agentId,
 * Gateway identity, plugin name, or any other ambient string.
 */
import { randomUUID } from "node:crypto";

const HOST_DELEGATION_INTENT: unique symbol = Symbol("openclaw.hostDelegationIntent");
const hostDelegationIntents = new WeakSet<object>();

export type HostDelegationIntent = Readonly<{
  [HOST_DELEGATION_INTENT]: true;
  /** Owner family, e.g. "plugin". Never a bare display name. */
  ownerKind: string;
  /** Exact owner identity the Host bound this delegation to. */
  ownerId: string;
  /** Host-owned scope reference the delegation covers. */
  taskScopeRef: string;
  /** Host delegation identity. Distinct from delegateGoalRef. */
  delegationRef: string;
  /** Canonical delegated task lineage carried by Host execution contexts. */
  lineageRef: string;
  /** Delegate's own goal identity, when the Host already knows it. */
  delegateGoalRef: string | null;
}>;

function requireRef(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error("host delegation intent requires a non-empty " + label);
  }
  return value;
}

/**
 * Mints a Host delegation binding. This is the only way to produce one; the
 * returned object is frozen and registered so it can be recognised as Host-made.
 */
export function createHostDelegationIntent(params: {
  ownerKind: string;
  ownerId: string;
  taskScopeRef: string;
  delegationRef?: string;
  lineageRef?: string;
  delegateGoalRef?: string | null;
}): HostDelegationIntent {
  const delegationRef = params.delegationRef ?? "delegation:" + randomUUID();
  const lineageRef = params.lineageRef ?? "lineage:" + randomUUID();
  const intent = Object.freeze({
    [HOST_DELEGATION_INTENT]: true as const,
    ownerKind: requireRef(params.ownerKind, "owner kind"),
    ownerId: requireRef(params.ownerId, "owner id"),
    taskScopeRef: requireRef(params.taskScopeRef, "task scope reference"),
    delegationRef: requireRef(delegationRef, "delegation reference"),
    lineageRef: requireRef(lineageRef, "lineage reference"),
    delegateGoalRef: params.delegateGoalRef ?? null,
  });
  hostDelegationIntents.add(intent);
  return intent;
}

/**
 * Reads a Host-minted delegation intent. Returns undefined for anything the
 * Host did not mint, including structurally identical forgeries.
 */
export function readHostDelegationIntent(value: unknown): HostDelegationIntent | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  return hostDelegationIntents.has(value) ? (value as HostDelegationIntent) : undefined;
}
