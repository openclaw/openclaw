import type { AgentRunTerminalOutcome } from "../../agents/agent-run-terminal-outcome.types.js";
import type { PersistedUserTurnMessage } from "../../sessions/user-turn-transcript.types.js";

export type SessionPendingInputState = "queued" | "interrupted" | "cancelled";

export type SessionPendingInputReceipt = {
  state: "queued" | "consumed";
  inputId: string;
  message: PersistedUserTurnMessage;
  run: <T>(operation: () => T) => T;
  runAsync?: <T>(operation: () => T) => Promise<Awaited<T>>;
  assertLifetimeCurrent?: () => void;
  /** Validate the original request before acknowledging a completed transcript replay. */
  validateCommittedReplay?: () => Promise<void>;
  finish: (disposition: Exclude<SessionPendingInputState, "queued">) => void;
  completion?: AgentRunTerminalOutcome;
  /** @deprecated Await completeAsync. Final compatibility day: 2026-12-31. Removal in the first January 2027 stable release. */
  complete?: (outcome: AgentRunTerminalOutcome) => AgentRunTerminalOutcome;
  completeAsync?: (outcome: AgentRunTerminalOutcome) => Promise<AgentRunTerminalOutcome>;
  settled?: () => Promise<void>;
};
