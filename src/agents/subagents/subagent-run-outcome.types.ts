import type { AgentRunDisposition } from "../internal-event-contract.js";

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
  startedAt?: number;
  endedAt?: number;
  elapsedMs?: number;
};
