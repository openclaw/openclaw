import { randomUUID } from "node:crypto";
import type { AgentRunDelegatedAuthority } from "./agent-run-authority.types.js";

export type AgentRunApprovalClosureReason = "approval-scope-closed" | "run-aborted";

type ApprovalLease = {
  authority: AgentRunDelegatedAuthority;
  parent: AgentRunDelegatedAuthority;
  signals: readonly AbortSignal[];
  close: (reason?: AgentRunApprovalClosureReason) => void;
};

/** Owns subordinate claims and signal listeners; the registry validates their admitted parent. */
export class AgentRunApprovalLeases {
  private readonly leases = new Map<string, ApprovalLease>();

  constructor(
    private readonly onClose: (
      authority: AgentRunDelegatedAuthority,
      reason: AgentRunApprovalClosureReason,
    ) => void,
  ) {}

  claim(
    root: AgentRunDelegatedAuthority,
    requestedParent: AgentRunDelegatedAuthority,
    inputSignals: readonly AbortSignal[],
  ): AgentRunDelegatedAuthority {
    const parent =
      requestedParent.claimId === root.claimId
        ? root
        : this.leases.get(requestedParent.claimId)?.authority;
    if (!parent) {
      throw new Error("agent run approval authority is no longer active");
    }
    const signals = Object.freeze([...new Set(inputSignals)]);
    for (const signal of signals) {
      signal.throwIfAborted();
    }
    for (const lease of this.leases.values()) {
      if (
        lease.parent === parent &&
        lease.signals.length === signals.length &&
        signals.every((signal) => lease.signals.includes(signal))
      ) {
        return lease.authority;
      }
    }
    const authority = Object.freeze({ ...parent, claimId: randomUUID() });
    const close = (reason: AgentRunApprovalClosureReason = "approval-scope-closed") => {
      if (!this.leases.delete(authority.claimId)) {
        return;
      }
      for (const signal of signals) {
        signal.removeEventListener("abort", onAbort);
      }
      for (const child of this.leases.values()) {
        if (child.parent === authority) {
          child.close(reason);
        }
      }
      // Approval closure must not revoke whole-run resources such as secret egress.
      this.onClose(authority, reason);
    };
    const onAbort = () => close();
    this.leases.set(authority.claimId, { authority, parent, signals, close });
    for (const signal of signals) {
      signal.addEventListener("abort", onAbort, { once: true });
    }
    return authority;
  }

  isActive(parent: AgentRunDelegatedAuthority, claimId: string): boolean {
    let lease = this.leases.get(claimId);
    while (lease) {
      if (lease.signals.some((signal) => signal.aborted)) {
        return false;
      }
      if (lease.parent === parent) {
        return true;
      }
      lease = this.leases.get(lease.parent.claimId);
    }
    return false;
  }

  getAuthority(claimId: string): AgentRunDelegatedAuthority | undefined {
    return this.leases.get(claimId)?.authority;
  }

  release(claimId: string): boolean {
    const lease = this.leases.get(claimId);
    lease?.close();
    return lease !== undefined;
  }

  close(parent?: AgentRunDelegatedAuthority): void {
    for (const lease of this.leases.values()) {
      if (!parent || lease.parent === parent) {
        lease.close("run-aborted");
      }
    }
  }
}

/** The registry supplies the live root; lease ancestry can only narrow that owner. */
export function isCurrentAgentRunApprovalAuthority(
  root: AgentRunDelegatedAuthority,
  leases: AgentRunApprovalLeases | undefined,
  authority: AgentRunDelegatedAuthority,
  ancestor?: AgentRunDelegatedAuthority,
): boolean {
  const matchesRun = (candidate: AgentRunDelegatedAuthority) =>
    candidate.operationalRunInstance.instanceId === root.operationalRunInstance.instanceId &&
    candidate.operationalRunInstance.runId === root.operationalRunInstance.runId &&
    candidate.lifecycleGeneration === root.lifecycleGeneration;
  if (!matchesRun(authority)) {
    return false;
  }
  const current =
    root.claimId === authority.claimId || leases?.isActive(root, authority.claimId) === true;
  if (!current || !ancestor) {
    return current;
  }
  if (!matchesRun(ancestor)) {
    return false;
  }
  if (ancestor.claimId === root.claimId) {
    return true;
  }
  const parent = leases?.getAuthority(ancestor.claimId);
  return Boolean(
    parent &&
    leases?.isActive(root, parent.claimId) &&
    (authority.claimId === parent.claimId || leases.isActive(parent, authority.claimId)),
  );
}
