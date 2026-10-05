import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { AgentRunTerminalOutcome } from "../../agents/agent-run-terminal-outcome.types.js";
import type { PersistedUserTurnMessage } from "../../sessions/user-turn-transcript.types.js";
import type {
  AcceptedGoalRecoveryInput,
  GoalRecoveryInputAdmission,
  SessionGoalOperationResult,
  SessionTranscriptTurnMutationResult,
} from "./goals-operations.types.js";
import type { TurnRecoveryIntent } from "./main-session-recovery.types.js";
import type { SessionEntryReplacementPublication } from "./session-accessor.sqlite-entry-cache.types.js";
import type {
  SessionPendingInputRow,
  readSessionInputCompletion,
} from "./session-accessor.sqlite-pending-inputs.js";
import type { SessionPendingInputAuthorityFacts } from "./session-pending-input-authority.js";
import type { InternalSessionEntry } from "./types.js";

type PendingInputIdentity = {
  sessionKey: string;
  sessionId: string;
  idempotencyKey: string;
};

export type PendingInputRead =
  | PendingInputStageRead
  | PendingInputSourceRead
  | PendingInputQueueRead
  | { kind: "committed-recovery"; sessionKey: string; sessionId: string };

export type CommittedRecoveryInput = {
  inputId: string;
  runId: string;
  idempotencyKey: string;
  profileId: string;
  fingerprint: string;
};

export type CommittedRecoveryInputSnapshot = {
  kind: "committed-recovery";
  current: boolean;
  blocked?: true;
  effectHold?: true;
  input?: CommittedRecoveryInput;
};

type PendingInputQueueRead = {
  kind: "queue";
  sessionKey: string;
  sessionId: string;
  runId?: string;
  afterSeq?: number;
  throughSeq?: number;
};

export type PendingInputQueueCandidate = Pick<
  SessionPendingInputRow,
  | "seq"
  | "input_id"
  | "session_key"
  | "session_id"
  | "idempotency_key"
  | "run_id"
  | "lifecycle_generation"
  | "state"
> & {
  rowFingerprint: string;
  ownerDeviceId?: string;
};

export type PendingInputQueueSnapshot = {
  kind: "queue";
  current: boolean;
  entry?: InternalSessionEntry;
  rows: PendingInputQueueCandidate[];
  row?: PendingInputQueueCandidate;
  throughSeq: number;
  nextAfterSeq?: number;
};

type PendingInputStageRead = PendingInputIdentity & {
  kind: "stage";
  trackCompletion: boolean;
  goalOperation?: GoalRecoveryInputAdmission["operation"];
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
  entry?: InternalSessionEntry;
  goalReceipt?: SessionGoalOperationResult;
  existing?: SessionPendingInputRow;
  previous?: ReturnType<typeof readSessionInputCompletion>;
  committed?: { messageId: string; message: PersistedUserTurnMessage };
};

type PendingInputSettlementIdentity = PendingInputIdentity & {
  authorityAgentId?: string;
  runId: string;
  requestHash: string;
  lifecycleGeneration: string;
};

type PendingInputRowMutation =
  | (PendingInputSettlementIdentity & {
      kind: "stage";
      expected: PendingInputSnapshot;
      trackCompletion: boolean;
      inputId: string;
      messageJson: string;
      turnIntent?: TurnRecoveryIntent;
      goalRecovery?: AcceptedGoalRecoveryInput;
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

export type PendingInputQueueMutation = {
  sessionKey: string;
  sessionId: string;
  lifecycleGeneration: string;
  expectedEntry: InternalSessionEntry;
  idempotencyKey?: never;
  runId?: never;
  requestHash?: never;
} & (
  | { kind: "promote" }
  | { kind: "recover-accepted"; row: PendingInputQueueCandidate }
  | { kind: "recover-committed"; input: CommittedRecoveryInput; intent: TurnRecoveryIntent }
  | { kind: "cancel-queued"; row: PendingInputQueueCandidate }
);

export type PendingInputMutation = PendingInputRowMutation | PendingInputQueueMutation;

export type PendingInputMutationReceipt = {
  kind: "pending-input-settlement";
  operation: PendingInputMutation["kind"];
  sessionKey: string;
  sessionId: string;
  lifecycleGeneration: string;
  outcome?: AgentRunTerminalOutcome;
  goalOperation?: SessionTranscriptTurnMutationResult;
  publication?: SessionEntryReplacementPublication;
} & (
  | {
      operation: PendingInputRowMutation["kind"];
      idempotencyKey: string;
      runId: string;
      requestHash: string;
    }
  | {
      operation: PendingInputQueueMutation["kind"];
      idempotencyKey?: never;
      runId?: never;
      requestHash?: never;
      changed: boolean;
      entry?: InternalSessionEntry;
    }
);

export type PendingInputCustodyGrant = {
  kind: "pending-input-settlement-custody";
  candidate?: SessionPendingInputRow;
  receipt: PendingInputMutationReceipt;
  authority?: SessionPendingInputAuthorityFacts;
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
