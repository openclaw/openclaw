import { formatDurationMs } from "../infra/parse-duration.js";

/**
 * In-memory store for time-bounded exec approvals.
 *
 * A timed approval grants automatic `allow-once` responses to exec approval requests
 * whose command text matches a stored pattern, until the approval window expires.
 *
 * Timed approvals do NOT survive gateway restarts (by design).
 */

export type TimedApprovalEntry = {
  /** Pattern to match against commandText (substring match). */
  commandPattern: string;
  /** The agent ID this approval is scoped to (or null = any agent). */
  agentId: string | null;
  /** Granted by (channel:senderId). */
  grantedBy: string;
  /** When the approval was created. */
  createdAtMs: number;
  /** When the approval expires (Date.now() + durationMs). */
  approvedUntil: number;
};

export class TimedApprovalStore {
  private entries: TimedApprovalEntry[] = [];

  /**
   * Add a timed approval entry.
   */
  add(entry: Omit<TimedApprovalEntry, "createdAtMs">): void {
    this.purgeExpired();
    this.entries.push({ ...entry, createdAtMs: Date.now() });
  }

  /**
   * Check whether a given commandText is covered by any active timed approval.
   * Returns the matching entry if active, null otherwise.
   */
  findActive(commandText: string, agentId?: string | null): TimedApprovalEntry | null {
    this.purgeExpired();
    const now = Date.now();
    for (const entry of this.entries) {
      if (entry.approvedUntil <= now) {
        continue;
      }
      if (entry.agentId !== null && entry.agentId !== agentId) {
        continue;
      }
      if (commandText.toLowerCase().includes(entry.commandPattern.toLowerCase())) {
        return entry;
      }
    }
    return null;
  }

  /**
   * Return all currently active entries (for display / CLI).
   */
  listActive(): TimedApprovalEntry[] {
    this.purgeExpired();
    const now = Date.now();
    return this.entries.filter((e) => e.approvedUntil > now);
  }

  /**
   * Format active entries for display in CLI / chat.
   */
  formatActive(): string {
    const active = this.listActive();
    if (active.length === 0) {
      return "No active timed approvals.";
    }
    const now = Date.now();
    const lines = active.map((e) => {
      const remaining = formatDurationMs(e.approvedUntil - now);
      const agentLabel = e.agentId ? `, agent: ${e.agentId}` : "";
      return `  ${e.commandPattern}  →  expires in ${remaining} (${e.grantedBy}${agentLabel})`;
    });
    return `Timed approvals (active):\n${lines.join("\n")}`;
  }

  /**
   * Remove all expired entries.
   */
  purgeExpired(): void {
    const now = Date.now();
    this.entries = this.entries.filter((e) => e.approvedUntil > now);
  }

  /**
   * Clear all entries (e.g., on gateway shutdown/restart).
   */
  clear(): void {
    this.entries = [];
  }
}

/** Singleton instance used across the gateway process. */
export const timedApprovalStore = new TimedApprovalStore();
