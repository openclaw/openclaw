import { isRecord } from "@openclaw/normalization-core/record-coerce";
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

/** Only the paired kernel's receipt for this exact accepted input may settle its custody. */
export function readPendingInputMutationReceipt(
  facts: unknown,
  input: PendingInputMutation,
): PendingInputMutationReceipt | undefined {
  if (
    !isRecord(facts) ||
    facts.kind !== "pending-input-settlement" ||
    facts.operation !== input.kind ||
    facts.sessionKey !== input.sessionKey ||
    facts.sessionId !== input.sessionId ||
    facts.idempotencyKey !== input.idempotencyKey ||
    facts.runId !== input.runId ||
    facts.requestHash !== input.requestHash ||
    facts.lifecycleGeneration !== input.lifecycleGeneration
  ) {
    return undefined;
  }
  // SAFETY: The exact paired kernel and admission own this tagged native receipt.
  return facts as PendingInputMutationReceipt;
}
