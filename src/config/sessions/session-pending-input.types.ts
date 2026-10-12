import type { Selectable } from "kysely";
import type { AgentRunTerminalOutcome } from "../../agents/agent-run-terminal-outcome.types.js";
import type { PersistedUserTurnMessage } from "../../sessions/user-turn-transcript.types.js";
import type {
  SessionPendingInputs,
  SessionInputCompletions,
} from "../../state/openclaw-agent-db.generated.js";
import type { SessionPendingInputState } from "./session-pending-input-receipt.types.js";

export type SessionPendingInput = {
  id: string;
  runId: string;
  message: PersistedUserTurnMessage;
  acceptedAt: number;
  state: SessionPendingInputState;
};
export type SessionPendingInputPage = {
  items: SessionPendingInput[];
  total: number;
  nextBefore?: number;
};
export type SessionPendingInputRow = Selectable<SessionPendingInputs>;
/** Transported facts do not grant custody; the host retains and checks the exact live owner. */
export type SessionPendingInputWorkerFacts = {
  agentId?: string;
  databaseAgentId?: string;
  inputId: string;
  transcriptInputId: string;
  sessionId: string;
  sessionKey: string;
  /** Native cache locator; may be the process-held incognito sentinel. */
  databasePath: string;
  idempotencyKey: string;
  lifecycleGeneration: string;
  messageJson: string;
  preparedAuthority?: true;
  sources?: readonly SessionPendingInputWorkerFacts[];
};

export type SessionPendingInputWorkerReceipt = {
  transcriptInputId: string;
  consumedInputIds: string[];
};

export type SessionPendingInputAppend = {
  inputId: string;
  message: PersistedUserTurnMessage;
  alreadyPromoted: boolean;
  sourceInputIds?: readonly string[];
  stageRelocation?: (destinationInputId: string) => void;
};

export type SessionInputCompletion = Selectable<SessionInputCompletions> & {
  outcome: AgentRunTerminalOutcome;
};
