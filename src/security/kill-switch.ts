/**
 * Kill Switch
 *
 * Emergency mechanism to halt all AI agent activity at global, agent,
 * or session scope. Registers at priority 1000 (highest) so it blocks
 * before any other hook can execute.
 *
 * Addresses: T-IMPACT-001 (P1)
 */

export type KillSwitchScope = "global" | "agent" | "session";

export type KillSwitchEntry = {
  scope: KillSwitchScope;
  key?: string; // agent ID or session key (not needed for global)
  reason: string;
  activatedAt: number;
  activatedBy?: string;
};

export type KillSwitchStatus = {
  active: boolean;
  entries: KillSwitchEntry[];
};

export class KillSwitch {
  private entries: KillSwitchEntry[] = [];

  /**
   * Activate the kill switch.
   */
  activate(params: {
    scope: KillSwitchScope;
    key?: string;
    reason: string;
    activatedBy?: string;
  }): KillSwitchEntry {
    // Don't duplicate entries
    const existing = this.entries.find((e) => e.scope === params.scope && e.key === params.key);
    if (existing) {
      existing.reason = params.reason;
      existing.activatedAt = Date.now();
      existing.activatedBy = params.activatedBy;
      return existing;
    }

    const entry: KillSwitchEntry = {
      scope: params.scope,
      key: params.key,
      reason: params.reason,
      activatedAt: Date.now(),
      activatedBy: params.activatedBy,
    };
    this.entries.push(entry);
    return entry;
  }

  /**
   * Deactivate the kill switch for a specific scope/key.
   */
  deactivate(scope: KillSwitchScope, key?: string): boolean {
    const before = this.entries.length;
    this.entries = this.entries.filter((e) => !(e.scope === scope && e.key === key));
    return this.entries.length < before;
  }

  /**
   * Check if activity should be blocked for the given context.
   */
  isBlocked(params?: { agentId?: string; sessionKey?: string }): {
    blocked: boolean;
    reason?: string;
  } {
    // Global kill switch blocks everything
    const global = this.entries.find((e) => e.scope === "global");
    if (global) {
      return { blocked: true, reason: `Global kill switch: ${global.reason}` };
    }

    // Agent-scoped kill switch
    if (params?.agentId) {
      const agent = this.entries.find((e) => e.scope === "agent" && e.key === params.agentId);
      if (agent) {
        return { blocked: true, reason: `Agent kill switch (${params.agentId}): ${agent.reason}` };
      }
    }

    // Session-scoped kill switch
    if (params?.sessionKey) {
      const session = this.entries.find(
        (e) => e.scope === "session" && e.key === params.sessionKey,
      );
      if (session) {
        return {
          blocked: true,
          reason: `Session kill switch (${params.sessionKey}): ${session.reason}`,
        };
      }
    }

    return { blocked: false };
  }

  /**
   * Get current status.
   */
  status(): KillSwitchStatus {
    return {
      active: this.entries.length > 0,
      entries: [...this.entries],
    };
  }

  /**
   * Deactivate all kill switches.
   */
  deactivateAll(): void {
    this.entries = [];
  }
}
