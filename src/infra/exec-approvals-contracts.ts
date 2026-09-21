// Shared type contracts for exec approval policy and durable persistence.
import type { ExecApprovalPolicySnapshot } from "./exec-approval-policy-snapshot.js";
import type { AllowAlwaysPattern } from "./exec-approvals-allowlist.js";
import type { ExecApprovalsSnapshot, ExecAsk, ExecSecurity } from "./exec-approvals-core.js";
import type { ExecAllowlistEntry } from "./exec-approvals.types.js";

export type ExecApprovalsDefaultOverrides = {
  security?: ExecSecurity;
  ask?: ExecAsk;
  askFallback?: ExecSecurity;
  autoAllowSkills?: boolean;
  requireSocket?: boolean;
};

export type AllowAlwaysPersistenceReason =
  | "no-reusable-pattern"
  | "prompt-only"
  | "runtime-payload"
  | "unplanned";

export type AllowAlwaysPersistenceDecision =
  | { kind: "patterns"; patterns: readonly AllowAlwaysPattern[]; commandText?: string }
  | { kind: "exact-command"; commandText: string }
  | { kind: "one-shot"; reasons: AllowAlwaysPersistenceReason[] };

export type ExecApprovalUsageAuthorization = {
  source: "current-policy" | "ask-fallback" | "explicit-approval" | "auto-review";
  security: ExecSecurity;
  ask: ExecAsk;
  bypassHostApprovalFloors?: boolean;
  allowlistSatisfied: boolean;
  policySnapshot?: ExecApprovalPolicySnapshot;
  requireAutoAllowSkills?: boolean;
  requireExactCommandApproval?: boolean;
  requireDurableAllowlistApproval?: boolean;
};

export type ExecAuthorizationCommitInput = {
  agentId: string | undefined;
  matches: readonly ExecAllowlistEntry[];
  command: string;
  resolvedPath?: string;
  authorization: ExecApprovalUsageAuthorization;
  allowAlwaysDecision?: AllowAlwaysPersistenceDecision;
};

export type ExecAuthorizationCommitOutcome =
  | { ok: true; snapshot: ExecApprovalsSnapshot }
  | { ok: false; message: string };

export type ExecAuthorizationWorkerOperations = {
  "execApprovals.commitAuthorizations": {
    input: { items: ExecAuthorizationCommitInput[] };
    output: ExecAuthorizationCommitOutcome[];
  };
};
