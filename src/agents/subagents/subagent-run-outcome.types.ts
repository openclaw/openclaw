import type { AgentRunDisposition } from "../internal-event-contract.js";

/**
 * Which of the two events a `timeout` outcome actually records.
 *
 * `child-stopped` — the gateway reported the child run itself settled, so the
 * outcome is terminal and its timing describes the child.
 * `child-unconfirmed` — only a deadline elapsed (this waiter's budget, or the
 * stored run deadline). No stop was observed, so the child may still be
 * running and the outcome describes the end of the WAIT, not of the run.
 */
export type SubagentTimeoutDisposition = "child-stopped" | "child-unconfirmed";

export type SubagentRunOutcome = {
  status: "ok" | "error" | "timeout" | "unknown";
  /**
   * Written only by producers that observed something other than the run
   * publishing its own terminal state: a waiter whose budget expired while the
   * run stayed live, or a kill. Absence therefore means `exited`; read it
   * through `resolveSubagentRunDisposition` rather than defaulting inline.
   */
  disposition?: AgentRunDisposition;
  error?: string;
  /** Legacy persisted timeout evidence. New outcomes write `disposition` only. */
  timeoutDisposition?: SubagentTimeoutDisposition;
  startedAt?: number;
  endedAt?: number;
  elapsedMs?: number;
};
