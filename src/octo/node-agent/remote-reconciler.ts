// Octopus Orchestrator — RemoteReconciler (M4-06)
//
// On Node Agent reconnect after a network partition:
//   1. Replay the pending log to the Head (send unacked transitions).
//   2. Run SessionReconciler to detect local discrepancies.
//   3. Return a combined report with replay count and reconciliation data.
//
// Context docs:
//   - LLD SS Node Agent Internals -- replay-on-reconnect contract
//   - src/octo/node-agent/pending-log.ts (M4-05) -- PendingLog interface
//   - src/octo/node-agent/session-reconciler.ts (M1-13) -- SessionReconciler
//
// Boundary discipline (OCTO-DEC-033):
//   Only `node:*` builtins and relative imports inside `src/octo/`.

import type { PendingLog, PendingTransition } from "./pending-log.ts";
import type { SessionReconciler, ReconciliationReport } from "./session-reconciler.ts";

// ======================================================================
// Transport interface
// ======================================================================

/**
 * Minimal transport abstraction for sending replayed transitions to the
 * Head. The Node Agent injects its real WebSocket/RPC transport; tests
 * inject a stub.
 */
export interface ReplayTransport {
  send(method: string, data: unknown): Promise<unknown>;
}

// ======================================================================
// RemoteReconciler
// ======================================================================

export class RemoteReconciler {
  constructor(
    private readonly pendingLog: PendingLog,
    private readonly sessionReconciler: SessionReconciler,
    private readonly transport: ReplayTransport,
  ) {}

  /**
   * Execute the full reconnect reconciliation sequence:
   *   1. Replay every unacked transition from the pending log via the
   *      transport (sequential to preserve ordering).
   *   2. Run SessionReconciler.reconcile() to detect local drift.
   *   3. Return a combined result.
   *
   * Transport errors during replay are collected but do not abort the
   * sequence -- all entries are attempted, and the caller receives the
   * count of successfully replayed entries alongside any failures.
   */
  async reconcileOnReconnect(): Promise<{
    replayed: number;
    replayErrors: Array<{ transitionId: string; error: string }>;
    reconciled: ReconciliationReport;
  }> {
    let replayed = 0;
    const replayErrors: Array<{ transitionId: string; error: string }> = [];

    await this.pendingLog.replay(async (t: PendingTransition) => {
      try {
        await this.transport.send("replay_transition", {
          id: t.id,
          arm_id: t.arm_id,
          event_type: t.event_type,
          payload: t.payload,
          ts: t.ts,
        });
        replayed++;
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        replayErrors.push({ transitionId: t.id, error: message });
      }
    });

    const reconciled = await this.sessionReconciler.reconcile();

    return { replayed, replayErrors, reconciled };
  }
}
