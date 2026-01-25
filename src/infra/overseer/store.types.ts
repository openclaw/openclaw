import type { DeliveryContext } from "../../utils/delivery-context.js";

export type OverseerGoalStatus = "active" | "paused" | "completed" | "cancelled" | "archived";
export type OverseerPriority = "low" | "normal" | "high" | "urgent";

export type OverseerWorkStatus =
  | "todo"
  | "queued"
  | "in_progress"
  | "blocked"
  | "done"
  | "cancelled";

export type OverseerAssignmentStatus =
  | "queued"
  | "dispatched"
  | "active"
  | "stalled"
  | "blocked"
  | "done"
  | "cancelled";

export type OverseerRiskLevel = "low" | "med" | "high";

export type OverseerPlanRevision = {
  ts: number;
  summary: string;
  diff?: string;
};

export type OverseerPlannerProvenance = {
  modelRef?: string;
  promptTemplateId?: string;
  promptTemplateHash?: string;
};

export type OverseerRiskEntry = {
  risk: string;
  impact?: string;
  mitigation?: string;
};

export type OverseerPlanNodeBase = {
  id: string;
  parentId?: string;
  path?: string;
  name: string;
  objective?: string;
  expectedOutcome?: string;
  acceptanceCriteria?: string[];
  definitionOfDone?: string;
  dependsOn?: string[];
  blocks?: string[];
  suggestedAgentId?: string;
  suggestedAgentType?: string;
  requiredTools?: string[];
  estimatedEffort?: string;
  riskLevel?: OverseerRiskLevel;
  status: OverseerWorkStatus;
  blockedReason?: string;
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  endedAt?: number;
};

export type OverseerSubtask = OverseerPlanNodeBase;

export type OverseerTask = OverseerPlanNodeBase & {
  subtasks: OverseerSubtask[];
};

export type OverseerPhase = OverseerPlanNodeBase & {
  tasks: OverseerTask[];
};

export type OverseerPlan = {
  planVersion: number;
  phases: OverseerPhase[];
};

export type OverseerGoalRecord = {
  goalId: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  status: OverseerGoalStatus;
  priority: OverseerPriority;
  tags: string[];
  problemStatement: string;
  successCriteria: string[];
  nonGoals: string[];
  origin?: {
    sourceSessionKey?: string;
    originDeliveryContext?: DeliveryContext;
  };
  owner?: string;
  stakeholders?: string[];
  repoContextSnapshot?: string;
  constraints?: string[];
  assumptions?: string[];
  risks?: OverseerRiskEntry[];
  planner?: OverseerPlannerProvenance;
  plannerInputs?: string;
  rawPlannerOutputJson?: unknown;
  validationErrors?: string[];
  planRevisionHistory?: OverseerPlanRevision[];
  plan?: OverseerPlan;
};

export type OverseerRecoveryPolicy = "resend_last" | "nudge" | "replan" | "reassign" | "escalate";

export type OverseerDispatchHistoryEntry = {
  dispatchId: string;
  ts: number;
  mode: "sessions_send" | "sessions_spawn" | "escalate";
  target?: {
    sessionKey?: string;
    deliveryContext?: DeliveryContext;
  };
  instructionHash?: string;
  result?: "accepted" | "ok" | "timeout" | "error";
  runId?: string;
  notes?: string;
};

export type OverseerAssignmentRecord = {
  assignmentId: string;
  goalId: string;
  workNodeId: string;
  agentId?: string;
  sessionKey?: string;
  deliveryContext?: DeliveryContext;
  status: OverseerAssignmentStatus;
  lastInstructionText?: string;
  instructionHash?: string;
  dispatchHistory: OverseerDispatchHistoryEntry[];
  runId?: string;
  spawnedByKey?: string;
  createdAt: number;
  updatedAt: number;
  lastDispatchAt?: number;
  lastObservedActivityAt?: number;
  expectedNextUpdateAt?: number;
  idleAfterMs?: number;
  retryCount?: number;
  lastRetryAt?: number;
  backoffUntil?: number;
  recoveryPolicy?: OverseerRecoveryPolicy;
  blockedReason?: string;
  lastMessageFingerprint?: string;
};

export type OverseerCrystallizationEvidence = {
  filesTouched?: string[];
  commandsRun?: string[];
  testsRun?: string[];
  commits?: string[];
  prs?: string[];
  issues?: string[];
  externalRefs?: string[];
};

export type OverseerCrystallizationRecord = {
  crystallizationId: string;
  goalId: string;
  workNodeId?: string;
  summary?: string;
  currentState?: string;
  decisions?: string[];
  nextActions?: string[];
  openQuestions?: string[];
  knownBlockers?: string[];
  evidence?: OverseerCrystallizationEvidence;
  transcriptAnchors?: {
    sessionKey?: string;
    sessionId?: string;
    runId?: string;
    messageId?: string;
  };
  createdAt: number;
};

export type OverseerEvent = {
  ts: number;
  type: string;
  goalId?: string;
  assignmentId?: string;
  workNodeId?: string;
  data?: Record<string, unknown>;
};

export type OverseerDispatchIndexEntry = {
  dispatchId: string;
  assignmentId: string;
  ts: number;
  instructionHash?: string;
  mode: OverseerDispatchHistoryEntry["mode"];
};

export type OverseerStore = {
  version: 1;
  goals: Record<string, OverseerGoalRecord>;
  assignments: Record<string, OverseerAssignmentRecord>;
  crystallizations: Record<string, OverseerCrystallizationRecord>;
  dispatchIndex?: Record<string, OverseerDispatchIndexEntry>;
  events: OverseerEvent[];
  updatedAt?: number;
  safeMode?: { reason: string; at: number };
};

export type OverseerStructuredUpdate = {
  goalId?: string;
  workNodeId?: string;
  status?: OverseerWorkStatus | OverseerAssignmentStatus;
  summary?: string;
  next?: string;
  blockers?: string[];
  evidence?: OverseerCrystallizationEvidence;
};
