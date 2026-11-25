import { createDeferredCore } from "../../shared/deferred.js";
import type {
  AgentTerminalOwner,
  AgentTerminalSessionDrain,
  TerminalOwner,
  TerminalPendingOpen,
  TerminalSession,
} from "./session-manager.types.js";

export function agentTerminalOwnerMatches(
  owner: TerminalOwner | null,
  expected: AgentTerminalOwner,
): boolean {
  return (
    owner?.kind === "agent" &&
    owner.agentSessionKey === expected.agentSessionKey &&
    owner.agentSessionId === expected.agentSessionId &&
    owner.agentId === expected.agentId
  );
}

function drainKey(owner: AgentTerminalOwner | string): string {
  return JSON.stringify(
    typeof owner === "string"
      ? [owner]
      : [owner.agentSessionKey, owner.agentSessionId, owner.agentId],
  );
}

export class AgentTerminalSessionDrainTracker {
  private readonly active = new Map<string, Set<() => void>>();
  private readonly exiting = new Set<TerminalSession>();

  begin(
    owner: AgentTerminalOwner | string,
    params: {
      pendingOpens: ReadonlyMap<TerminalPendingOpen, TerminalOwner>;
      sessions: ReadonlyMap<string, TerminalSession>;
      closeSession: (session: TerminalSession) => void;
      assertCurrent?: () => void;
    },
  ): AgentTerminalSessionDrain {
    params.assertCurrent?.();
    const matches = (terminalOwner: TerminalOwner | null, agentId: string) =>
      typeof owner === "string"
        ? agentId === owner
        : agentTerminalOwnerMatches(terminalOwner, owner);
    const pending = [...params.pendingOpens]
      .filter(([entry, pendingOwner]) => matches(pendingOwner, entry.agentId))
      .map(([entry]) => entry);
    const sessions = [...params.sessions.values()].filter(
      (session) => !session.closed && matches(session.owner, session.agentId),
    );
    let pendingWork = pending;
    let sessionWork = [
      ...sessions,
      ...[...this.exiting].filter((session) => matches(session.owner, session.agentId)),
    ];
    const hasWork = () =>
      pendingWork.some((entry) => params.pendingOpens.has(entry)) ||
      sessionWork.some((session) => !session.closed || this.exiting.has(session));
    const key = drainKey(owner);
    const drained = createDeferredCore();
    let failure: { error: unknown } | undefined;
    let cancelling = true;
    const settle = () => {
      if (!cancelling && !hasWork()) {
        if (failure) {
          drained.reject(failure.error);
        } else {
          drained.resolve();
        }
      }
    };
    const receipts = this.active.get(key) ?? new Set<() => void>();
    receipts.add(settle);
    this.active.set(key, receipts);
    const receipt: AgentTerminalSessionDrain = {
      drained: drained.promise,
      hasWork,
      release: () => {
        if (receipts.delete(settle) && receipts.size === 0) {
          this.active.delete(key);
        }
      },
    };
    let cancelledPending = 0;
    try {
      for (const entry of pending) {
        params.assertCurrent?.();
        entry.abort("terminal closed because its owner is draining");
        cancelledPending += 1;
      }
      for (const session of sessions) {
        if (!session.closed) {
          params.assertCurrent?.();
          params.closeSession(session);
        }
      }
    } catch (error) {
      pendingWork = pending.slice(0, cancelledPending);
      sessionWork = sessions.filter((session) => session.closed);
      if (pendingWork.length === 0 && sessionWork.length === 0) {
        receipt.release();
        throw error;
      }
      failure = { error };
    }
    cancelling = false;
    settle();
    return receipt;
  }

  isActive(owner: TerminalOwner, agentId: string): boolean {
    return (
      this.active.has(drainKey(agentId)) ||
      (owner.kind === "agent" && this.active.has(drainKey(owner)))
    );
  }

  trackExit(session: TerminalSession): void {
    this.exiting.add(session);
  }

  observeExit(session: TerminalSession): void {
    this.exiting.delete(session);
  }

  settleIfIdle(owner: TerminalOwner | null, agentId: string): void {
    // Each receipt retains only the work whose cancellation it accepted.
    for (const key of [drainKey(agentId), ...(owner?.kind === "agent" ? [drainKey(owner)] : [])]) {
      for (const settle of this.active.get(key) ?? []) {
        settle();
      }
    }
  }
}
