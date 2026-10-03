import { createDeferredCore } from "../../shared/deferred.js";
import type {
  AgentTerminalOwner,
  AgentTerminalSessionDrain,
  TerminalOwner,
  TerminalSession,
} from "./session-manager.types.js";

export function agentTerminalOwnerMatches(
  owner: TerminalOwner | null,
  expected: AgentTerminalOwner,
): boolean {
  if (owner?.kind !== "agent") {
    return false;
  }
  return (
    owner.agentSessionKey === expected.agentSessionKey &&
    owner.agentSessionId === expected.agentSessionId &&
    owner.agentId === expected.agentId
  );
}

function drainKey(owner: AgentTerminalOwner): string {
  return JSON.stringify([owner.agentSessionKey, owner.agentSessionId, owner.agentId]);
}

export class AgentTerminalSessionDrainTracker {
  private readonly active = new Map<string, Set<() => void>>();
  private readonly exiting = new Set<TerminalSession>();

  begin(owner: AgentTerminalOwner, hasWork: () => boolean): AgentTerminalSessionDrain {
    const key = drainKey(owner);
    const drained = createDeferredCore();
    const receipts = this.active.get(key) ?? new Set<() => void>();
    receipts.add(drained.resolve);
    this.active.set(key, receipts);
    this.resolveIfIdle(owner, hasWork);
    return {
      drained: drained.promise,
      hasWork,
      release: () => {
        if (receipts.delete(drained.resolve) && receipts.size === 0) {
          this.active.delete(key);
        }
      },
    };
  }

  isActive(owner: AgentTerminalOwner): boolean {
    return this.active.has(drainKey(owner));
  }

  trackExit(session: TerminalSession): void {
    this.exiting.add(session);
  }

  observeExit(session: TerminalSession): void {
    this.exiting.delete(session);
  }

  hasExiting(owner: AgentTerminalOwner): boolean {
    return [...this.exiting].some((session) => agentTerminalOwnerMatches(session.owner, owner));
  }

  resolveIfIdle(owner: AgentTerminalOwner, hasWork: () => boolean): void {
    if (hasWork()) {
      return;
    }
    // Settled receipts retain admission until their own lifecycle mutation releases.
    for (const resolve of this.active.get(drainKey(owner)) ?? []) {
      resolve();
    }
  }
}
