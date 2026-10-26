import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { AgentRunTerminalOutcome } from "../../agents/agent-run-terminal-outcome.types.js";
import type { PersistedUserTurnMessage } from "../../sessions/user-turn-transcript.types.js";
import type { SessionPendingInputAuthorityFacts } from "./session-pending-input-authority.js";
import type {
  SessionPendingInputRow,
  SessionInputCompletion,
} from "./session-pending-input.types.js";

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
  /** Also report whether a found pending row already reached the transcript. */
  commitEvidence?: true;
};

export type PendingInputSourceSnapshot = {
  kind: "source";
  current: boolean;
  pending?: SessionPendingInputRow;
  committed?: PersistedUserTurnMessage;
  committedMessageSeq?: number;
  /** Present only for commitEvidence reads that found a pending row. */
  pendingCommit?: { transcriptIndexCurrent: boolean; committed: boolean };
};

export type PendingInputSnapshot = {
  kind: "stage";
  current: boolean;
  existing?: SessionPendingInputRow;
  previous?: SessionInputCompletion;
  committed?: { messageId: string; message: PersistedUserTurnMessage };
};

type PendingInputSettlementIdentity = PendingInputIdentity & {
  authorityAgentId?: string;
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
  withdrawnInputId?: string;
  stagedInput?: SessionPendingInputRow;
};

export type PendingInputCustodyGrant = {
  kind: "pending-input-settlement-custody";
  candidate?: SessionPendingInputRow;
  receipt: PendingInputMutationReceipt;
  authority?: SessionPendingInputAuthorityFacts;
};

/** Decode the retained operation's paired native receipt. */
export function readPendingInputMutationReceipt(
  facts: unknown,
): PendingInputMutationReceipt | undefined {
  if (!isRecord(facts) || facts.kind !== "pending-input-settlement") {
    return undefined;
  }
  // SAFETY: The exact paired kernel and admission own this tagged native receipt.
  return facts as PendingInputMutationReceipt;
}
