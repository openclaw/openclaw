import type { AgentRunTerminalOutcome } from "../../agents/agent-run-terminal-outcome.types.js";
import type { PersistedUserTurnMessage } from "../../sessions/user-turn-transcript.types.js";
import type {
  SessionPendingInputRow,
  readSessionInputCompletion,
} from "./session-accessor.sqlite-pending-inputs.js";

type PendingInputIdentity = {
  sessionKey: string;
  sessionId: string;
  idempotencyKey: string;
};

export type PendingInputRead = PendingInputStageRead | PendingInputSourceRead;

type PendingInputStageRead = PendingInputIdentity & {
  kind: "stage";
  trackCompletion: boolean;
};

export type PendingInputSourceRead = PendingInputIdentity & {
  kind: "source";
  pendingOnly: boolean;
};

export type PendingInputSourceSnapshot = {
  kind: "source";
  current: boolean;
  pending?: SessionPendingInputRow;
  committed?: PersistedUserTurnMessage;
};

export type PendingInputSnapshot = {
  kind: "stage";
  current: boolean;
  existing?: SessionPendingInputRow;
  previous?: ReturnType<typeof readSessionInputCompletion>;
  committed?: { messageId: string; message: PersistedUserTurnMessage };
};

type PendingInputSettlementIdentity = PendingInputIdentity & {
  runId: string;
  requestHash: string;
  lifecycleGeneration: string;
};

export type PendingInputMutation =
  | (PendingInputSettlementIdentity & {
      kind: "stage";
      expected: PendingInputSnapshot;
      trackCompletion: boolean;
      inputId: string;
      messageJson: string;
    })
  | (PendingInputSettlementIdentity & {
      kind: "complete";
      outcome: AgentRunTerminalOutcome;
    })
  | (PendingInputSettlementIdentity & {
      kind: "finish";
      inputId: string;
      disposition: "cancelled" | "interrupted";
    });

export type PendingInputMutationReceipt = PendingInputIdentity & {
  kind: "pending-input-settlement";
  operation: PendingInputMutation["kind"];
  runId: string;
  requestHash: string;
  lifecycleGeneration: string;
  outcome?: AgentRunTerminalOutcome;
};

export type PendingInputCustodyGrant = {
  kind: "pending-input-settlement-custody";
  candidate?: SessionPendingInputRow;
  receipt: PendingInputMutationReceipt;
};
