// OpenClaw system-agent approval payload kept live until operator decision.
import type { UserChannelIdentity } from "../state/user-profiles.types.js";
import type { ExecApprovalDecision } from "./exec-approvals-core.js";

export type SystemAgentApprovalRequestPayload = {
  title: string;
  description: string;
  command: string;
  proposalHash: string;
  allowedDecisions: readonly ExecApprovalDecision[];
  agentId?: string | null;
  sessionKey?: string | null;
  sessionId: string;
  runId?: string | null;
  turnSourceChannel?: string | null;
  turnSourceTo?: string | null;
  turnSourceAccountId?: string | null;
  turnSourceThreadId?: string | number | null;
};

export type SystemAgentApprovalRequest = {
  /** Host-verified routing evidence; current approval authority is checked separately. */
  requesterChannelIdentity?: Readonly<UserChannelIdentity>;
  approvalKind?: "system-agent";
  id: string;
  request: SystemAgentApprovalRequestPayload;
  createdAtMs: number;
  expiresAtMs: number;
};

export type SystemAgentApprovalApplicationStatus = "applied" | "not-applied";

export type SystemAgentApprovalResolved = {
  id: string;
  decision: ExecApprovalDecision;
  resolvedBy?: string | null;
  ts: number;
  request?: SystemAgentApprovalRequestPayload;
  applicationStatus?: SystemAgentApprovalApplicationStatus;
  terminalStatus?: "expired" | "cancelled";
};

export const SYSTEM_AGENT_APPROVAL_TIMEOUT_MS = 10 * 60_000;
export const SYSTEM_AGENT_APPROVAL_DECISIONS = ["allow-once", "deny"] as const;
