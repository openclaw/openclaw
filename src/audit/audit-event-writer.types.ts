import type { DecisionReceiptV1 } from "../../packages/gateway-protocol/src/index.js";
import type {
  AgentRunFinishedAuditEventInput,
  AgentRunStartedAuditEventInput,
  AuditEventInput,
} from "./audit-event-types.js";
import type { ExecutionDecisionWork } from "./execution-decision-work.types.js";
import type { ExecutionIdentityAdmissionWork } from "./execution-identity-admission.js";

export type AuditWriterRequest =
  | { type: "record-event"; eventId: string; input: AuditEventInput }
  | {
      type: "record-run";
      start: AgentRunStartedAuditEventInput;
      finish: AgentRunFinishedAuditEventInput;
      eventIds: readonly [string, string];
    }
  | { type: "record-execution-identity"; work: ExecutionIdentityAdmissionWork }
  | { type: "record-execution-decision"; receipt: DecisionReceiptV1 }
  | { type: "record-execution-decision-work"; work: ExecutionDecisionWork };

/** Retry retains the FIFO suffix for contention or an unacknowledged idempotent batch. */
export type AuditWriterResult =
  | { status: "settled"; deleted?: number; error?: string }
  | { status: "retry" };
