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
  finish: (disposition: Exclude<SessionPendingInputState, "queued">) => void;
  completion?: AgentRunTerminalOutcome;
  /** @deprecated Await completeAsync. Final compatibility day: 2026-12-31. */
  complete?: (outcome: AgentRunTerminalOutcome) => AgentRunTerminalOutcome;
  completeAsync?: (outcome: AgentRunTerminalOutcome) => Promise<AgentRunTerminalOutcome>;
  settled?: () => Promise<void>;
};
