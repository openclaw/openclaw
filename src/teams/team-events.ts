/**
 * Event system for team state changes.
 * Enables real-time push to UI and notification hooks.
 *
 * Follows the same listener-set pattern as agent-events.ts / heartbeat-events.ts.
 */

// ─── Event types (discriminated union on `type`) ────────────────────

export type TeamEvent =
  | { type: "team_run_created"; teamRunId: string; name: string; leader: string }
  | { type: "team_run_completed"; teamRunId: string; state: "completed" | "failed" }
  | { type: "team_member_joined"; teamRunId: string; agentId: string; role?: string }
  | {
      type: "team_member_state_changed";
      teamRunId: string;
      agentId: string;
      state: "idle" | "running" | "done";
    }
  | { type: "team_message_sent"; teamRunId: string; messageId: string; from: string; to: string }
  | { type: "team_messages_read"; teamRunId: string; agentId: string; messageIds: string[] }
  | { type: "team_task_updated"; teamRunId: string; taskId: string; status: string };

export type TeamEventPayload = TeamEvent & { ts: number };

// ─── Internal listener registry ─────────────────────────────────────

const listeners = new Set<(evt: TeamEventPayload) => void>();

/** Emit a team event to all registered listeners. */
export function emitTeamEvent(event: TeamEvent): void {
  const enriched: TeamEventPayload = { ...event, ts: Date.now() };
  for (const listener of listeners) {
    try {
      listener(enriched);
    } catch {
      /* ignore listener errors */
    }
  }
}

/** Subscribe to team events. Returns an unsubscribe function. */
export function onTeamEvent(listener: (evt: TeamEventPayload) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
