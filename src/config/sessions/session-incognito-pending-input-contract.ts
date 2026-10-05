import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { SqliteWorkerError } from "../../infra/sqlite-worker-contract.js";
import type { IncognitoSessionFacts } from "./session-incognito-facts.types.js";
import type { IncognitoHistoryTarget } from "./session-incognito-history-contract.js";
import type {
  PendingInputHistoryGrant,
  PendingInputHistoryReceipt,
} from "./session-pending-input-history.types.js";
import {
  readPendingInputMutationReceipt,
  type PendingInputCustodyGrant,
  type PendingInputMutation,
  type PendingInputMutationReceipt,
  type PendingInputRead,
  type PendingInputSnapshot,
  type PendingInputQueueSnapshot,
  type CommittedRecoveryInputSnapshot,
  type PendingInputSourceSnapshot,
} from "./session-pending-input-operations.types.js";

export type IncognitoPendingInputOperations = {
  "session.pendingInputs.read": {
    input: PendingInputRead;
    output:
      | PendingInputSnapshot
      | PendingInputSourceSnapshot
      | PendingInputQueueSnapshot
      | CommittedRecoveryInputSnapshot;
  };
  "session.pendingInputs.mutate": {
    input: PendingInputMutation;
    output: PendingInputMutationReceipt;
  };
  "session.pendingInputs.interruptHistory": {
    input: IncognitoHistoryTarget & { ids: string[] };
    output: PendingInputHistoryReceipt;
  };
};

export function createIncognitoPendingInputSettlement(
  input: PendingInputMutation,
  admitCustody: (stage: "transaction" | "commit", facts: PendingInputCustodyGrant) => void,
) {
  const matches = (receipt: unknown) => readPendingInputMutationReceipt(receipt, input);
  return {
    authorize(stage: "transaction" | "commit", facts: unknown) {
      if (
        !isRecord(facts) ||
        facts.kind !== "pending-input-settlement-custody" ||
        !matches(facts.receipt)
      ) {
        throw new Error("Incognito pending input omitted its exact custody grant");
      }
      // SAFETY: The paired kernel owns the validated custody envelope.
      admitCustody(stage, facts as PendingInputCustodyGrant);
    },
    decodeReceipt(receipt: unknown) {
      if (!isRecord(receipt) || !Array.isArray(receipt.facts) || !matches(receipt.value)) {
        throw new SqliteWorkerError(
          "Incognito pending input omitted its committed receipt",
          "outcome-unknown",
        );
      }
      // SAFETY: Session facts are compared with the exact commit grant before publication.
      return receipt as { value: PendingInputMutationReceipt; facts: IncognitoSessionFacts[] };
    },
  };
}

export function createIncognitoPendingInputHistorySettlement(
  input: IncognitoPendingInputOperations["session.pendingInputs.interruptHistory"]["input"],
  admitCustody: (stage: "transaction" | "commit", facts: PendingInputHistoryGrant) => void,
) {
  const ids = new Set(input.ids);
  return {
    authorize(stage: "transaction" | "commit", facts: unknown) {
      if (
        !isRecord(facts) ||
        facts.kind !== "pending-input-history-custody" ||
        !Array.isArray(facts.candidates) ||
        facts.candidates.some(
          (row: unknown) =>
            !isRecord(row) ||
            typeof row.input_id !== "string" ||
            !ids.has(row.input_id) ||
            row.session_key !== input.sessionKey ||
            row.session_id !== input.sessionId,
        )
      ) {
        throw new Error("Incognito pending input history omitted its custody facts");
      }
      // SAFETY: The paired bounded kernel owns this validated custody envelope.
      admitCustody(stage, facts as PendingInputHistoryGrant);
    },
    decodeReceipt(receipt: unknown) {
      if (
        !isRecord(receipt) ||
        !Array.isArray(receipt.facts) ||
        !isRecord(receipt.value) ||
        receipt.value.kind !== "pending-input-history-interrupted" ||
        !Array.isArray(receipt.value.ids) ||
        receipt.value.ids.some((id: unknown) => typeof id !== "string" || !ids.has(id))
      ) {
        throw new SqliteWorkerError(
          "Incognito pending input history omitted its committed receipt",
          "outcome-unknown",
        );
      }
      // SAFETY: Session facts are compared with the exact commit grant before publication.
      return receipt as { value: PendingInputHistoryReceipt; facts: IncognitoSessionFacts[] };
    },
  };
}
