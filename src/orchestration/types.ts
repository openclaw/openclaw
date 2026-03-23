/**
 * Type definitions for Paperclip Orchestration layer in Operator1.
 * Matches schema migrations v18-v23.
 */

// ── Workspaces (v18) ────────────────────────────────────────────────────────

export type WorkspaceStatus = "active" | "archived" | "suspended";

export interface Workspace {
  id: string;
  name: string;
  description: string | null;
  status: WorkspaceStatus;
  taskPrefix: string;
  taskCounter: number;
  budgetMonthlyMicrocents: number | null;
  spentMonthlyMicrocents: number;
  brandColor: string | null;
  createdAt: number;
  updatedAt: number;
}

export type WorkspaceAgentStatus = "active" | "inactive" | "paused";

export interface WorkspaceAgent {
  workspaceId: string;
  agentId: string;
  role: string | null;
  status: WorkspaceAgentStatus;
  capabilities: string[];
  joinedAt: number;
}

// ── Tasks (v19) ─────────────────────────────────────────────────────────────

export type TaskStatus =
  | "backlog"
  | "todo"
  | "in_progress"
  | "in_review"
  | "blocked"
  | "done"
  | "cancelled";
export type TaskPriority = "low" | "medium" | "high" | "critical";
export type AuthorType = "agent" | "user" | "system";

export interface Task {
  id: string;
  workspaceId: string;
  projectId: string | null;
  goalId: string | null;
  parentId: string | null;
  identifier: string; // e.g. "OP1-001"
  title: string;
  description: string | null;
  status: TaskStatus;
  priority: TaskPriority;
  assigneeAgentId: string | null;
  billingCode: string | null;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
}

export interface TaskComment {
  id: string;
  taskId: string;
  authorId: string;
  authorType: AuthorType;
  body: string;
  createdAt: number;
}

// ── Goals (v20) ─────────────────────────────────────────────────────────────

export type GoalLevel = "vision" | "objective" | "key_result";
export type GoalStatus = "planned" | "in_progress" | "achieved" | "abandoned";

export interface Goal {
  id: string;
  workspaceId: string;
  parentId: string | null;
  title: string;
  description: string | null;
  level: GoalLevel;
  status: GoalStatus;
  ownerAgentId: string | null;
  progress: number;
  createdAt: number;
  updatedAt: number;
}

export interface GoalNode extends Goal {
  children: GoalNode[];
}

// ── Budgets & Cost Events (v21) ─────────────────────────────────────────────

export type BudgetScopeType = "workspace" | "agent" | "project";
export type BudgetWindowKind = "calendar_month_utc" | "lifetime";
export type BudgetIncidentType = "warning" | "hard_stop" | "resolved";

export interface CostEvent {
  id: string;
  workspaceId: string;
  agentId: string;
  sessionId: string | null;
  taskId: string | null;
  projectId: string | null;
  provider: string | null;
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  costMicrocents: number;
  occurredAt: number;
}

export interface BudgetPolicy {
  id: string;
  workspaceId: string;
  scopeType: BudgetScopeType;
  scopeId: string;
  amountMicrocents: number;
  windowKind: BudgetWindowKind;
  warnPercent: number;
  hardStop: number;
  createdAt: number;
  updatedAt: number;
}

export interface BudgetIncident {
  id: string;
  workspaceId: string;
  policyId: string;
  type: BudgetIncidentType;
  agentId: string | null;
  spentMicrocents: number;
  limitMicrocents: number;
  message: string | null;
  resolvedAt: number | null;
  createdAt: number;
}

// ── Approvals & Governance (v22) ────────────────────────────────────────────

export type ApprovalType = "agent_hire" | "budget_override" | "config_change";
export type ApprovalStatus = "pending" | "revision_requested" | "approved" | "rejected";
export type RequesterType = "agent" | "user" | "system";
export type ApprovalCommentAuthorType = "agent" | "user" | "system";

export interface Approval {
  id: string;
  workspaceId: string;
  type: ApprovalType;
  status: ApprovalStatus;
  requesterId: string;
  requesterType: RequesterType;
  payloadJson: string | null;
  decisionNote: string | null;
  decidedBy: string | null;
  decidedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface ApprovalComment {
  id: string;
  approvalId: string;
  authorId: string;
  authorType: ApprovalCommentAuthorType;
  body: string;
  createdAt: number;
}

export interface ActivityLogEntry {
  id: number;
  workspaceId: string;
  actorType: RequesterType;
  actorId: string | null;
  action: string;
  entityType: string | null;
  entityId: string | null;
  detailsJson: string | null;
  createdAt: number;
}

// ── Agent API Keys (v26) ─────────────────────────────────────────────────────

export interface AgentApiKey {
  id: string;
  agentId: string;
  workspaceId: string;
  name: string;
  keyPrefix: string;
  lastUsedAt: number | null;
  revokedAt: number | null;
  createdAt: number;
}

// ── Execution Workspaces (v27) ───────────────────────────────────────────────

export type ExecutionWorkspaceStatus = "active" | "archived" | "cleanup_pending";

export interface ExecutionWorkspace {
  id: string;
  workspaceId: string;
  projectId: string | null;
  taskId: string | null;
  agentId: string | null;
  name: string;
  mode: string;
  status: ExecutionWorkspaceStatus;
  workspacePath: string | null;
  baseRef: string | null;
  branchName: string | null;
  openedAt: number;
  closedAt: number | null;
  metadataJson: string | null;
}

export type WorkspaceOperationStatus = "pending" | "running" | "completed" | "failed";

export interface WorkspaceOperation {
  id: string;
  executionWorkspaceId: string;
  operationType: string;
  status: WorkspaceOperationStatus;
  detailsJson: string | null;
  startedAt: number;
  completedAt: number | null;
}

// ── Task Documents & Attachments (v28) ──────────────────────────────────────

export type TaskDocumentFormat = "markdown" | "plain" | "html";

export interface TaskDocument {
  id: string;
  taskId: string;
  title: string | null;
  format: TaskDocumentFormat;
  body: string;
  createdBy: string | null;
  updatedBy: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface TaskAttachment {
  id: string;
  taskId: string;
  filename: string;
  mimeType: string | null;
  sizeBytes: number | null;
  storagePath: string;
  createdBy: string | null;
  createdAt: number;
}

// ── Agent Config Revisions (v23) ────────────────────────────────────────────

export interface AgentConfigRevision {
  id: string;
  workspaceId: string;
  agentId: string;
  configJson: string;
  changedBy: string | null;
  changeNote: string | null;
  createdAt: number;
}

// ── Agent Wakeup Requests (v30) ──────────────────────────────────────────────

export type WakeupRequestStatus = "pending" | "processing" | "completed" | "failed";

export interface WakeupRequest {
  id: string;
  workspaceId: string;
  agentId: string;
  taskId: string | null;
  reason: string;
  status: WakeupRequestStatus;
  payloadJson: string | null;
  createdAt: number;
  processedAt: number | null;
}

// ── Finance Events (v29) ─────────────────────────────────────────────────────

export type FinanceEventKind =
  | "llm_inference"
  | "tool_call"
  | "budget_adjustment"
  | "manual_credit"
  | "manual_debit"
  | "refund"
  | "other";

export type FinanceEventDirection = "debit" | "credit";

export interface FinanceEvent {
  id: string;
  workspaceId: string;
  agentId: string | null;
  taskId: string | null;
  projectId: string | null;
  goalId: string | null;
  costEventId: string | null;
  billingCode: string | null;
  description: string | null;
  eventKind: FinanceEventKind;
  direction: FinanceEventDirection;
  provider: string | null;
  model: string | null;
  amountMicrocents: number;
  createdAt: number;
}
