import type { CronStandingGrantMintSpec } from "./operator-approval-standing-grants.types.js";
import type {
  ConsumeOperatorApprovalResult,
  ForceDenyOperatorApprovalResult,
  GetOperatorApprovalResult,
  InsertOperatorApprovalResult,
  NewOperatorApproval,
  OperatorApprovalDecision,
  OperatorApprovalKind,
  OperatorApprovalRecord,
  OperatorApprovalResolver,
  OperatorApprovalTerminalReason,
  ResolveOperatorApprovalResult,
  TerminalizeOperatorApprovalsResult,
} from "./operator-approval-store.types.js";

export type OperatorApprovalWorkerOperations = {
  "operatorApprovals.insert": {
    input: { approval: NewOperatorApproval };
    output: InsertOperatorApprovalResult;
  };
  "operatorApprovals.get": {
    input: { id: string; allowTransportRef?: boolean; nowMs?: number };
    output: GetOperatorApprovalResult;
  };
  "operatorApprovals.pending": {
    input: {
      kind?: OperatorApprovalKind;
      sourceSessionKey?: string;
      audienceSessionKey?: string;
      reviewerDeviceId?: string;
      limit?: number;
      nowMs?: number;
    };
    output: OperatorApprovalRecord[];
  };
  "operatorApprovals.resolve": {
    input: {
      id: string;
      decision: OperatorApprovalDecision;
      resolver: OperatorApprovalResolver;
      expectedKind?: OperatorApprovalKind;
      runtimeEpoch?: string;
      nowMs?: number;
      mcpToolGrant?: { agentId: string; server: string; tool: string };
      /** Cron-context allow-always mints this scoped grant in the same transaction. */
      standingGrant?: { kind: "cron" } & CronStandingGrantMintSpec & {
          expiresAtMs: number | null;
        };
    };
    output: ResolveOperatorApprovalResult;
  };
  "operatorApprovals.deny": {
    input: {
      id: string;
      status?: "denied" | "expired" | "cancelled";
      requireDue?: boolean;
      reason: OperatorApprovalTerminalReason;
      resolver: OperatorApprovalResolver;
      expectedKind?: OperatorApprovalKind;
      runtimeEpoch?: string;
      nowMs?: number;
    };
    output: ForceDenyOperatorApprovalResult;
  };
  "operatorApprovals.expire": {
    input: { nowMs?: number };
    output: TerminalizeOperatorApprovalsResult;
  };
  "operatorApprovals.consume": {
    input: {
      id: string;
      consumerId: string;
      expectedKind?: OperatorApprovalKind;
      runtimeEpoch?: string;
      redemptionWindowMs?: number;
      nowMs?: number;
    };
    output: ConsumeOperatorApprovalResult;
  };
};
