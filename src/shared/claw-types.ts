export const CLAW_MISSION_STATUSES = [
  "draft",
  "preflighting",
  "awaiting_setup",
  "awaiting_approval",
  "queued",
  "running",
  "recovering",
  "blocked",
  "verifying",
  "done",
  "failed",
  "paused",
  "cancelled",
] as const;

export type ClawMissionStatus = (typeof CLAW_MISSION_STATUSES)[number];

export type ClawContinuationPhase = Extract<
  ClawMissionStatus,
  "running" | "recovering" | "verifying"
>;

export type ClawManagedFlowStatus =
  | "queued"
  | "running"
  | "waiting"
  | "blocked"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "lost";

export type ClawPreflightCategory =
  | "workspace"
  | "runtime"
  | "browser"
  | "auth"
  | "external"
  | "tool";

export type ClawPreflightStatus = "ready" | "needs_setup" | "blocked" | "info";

export type ClawPreflightCheck = {
  id: string;
  category: ClawPreflightCategory;
  title: string;
  status: ClawPreflightStatus;
  summary: string;
  detail?: string | null;
  blocker?: boolean;
};

export type ClawDecisionKind =
  | "start_approval"
  | "preflight_blocker"
  | "operator_choice"
  | "recovery_uncertain";

export type ClawDecisionAction = "approve" | "reject" | "pause" | "cancel" | "continue";
export type ClawDecisionStatus = "pending" | "resolved";

export type ClawDecisionResponse = {
  action: ClawDecisionAction;
  note?: string | null;
  respondedAt: string;
};

export type ClawPendingDecision = {
  id: string;
  kind: ClawDecisionKind;
  title: string;
  summary: string;
  requestedAt: string;
  status: ClawDecisionStatus;
  response?: ClawDecisionResponse | null;
};

export type ClawControlState = {
  autonomyEnabled: boolean;
  pauseAll: boolean;
  stopAllNowRequestedAt?: string | null;
  updatedAt: string;
};

export type ClawMissionFileEntry = {
  name: string;
  path: string;
  kind: "markdown" | "state" | "audit" | "directory";
};

export type ClawMissionPacket = {
  source: "fallback" | "planned";
  summary: string;
  scopeIn: string[];
  scopeOut: string[];
  phases: string[];
  tasks: string[];
  doneCriteria: string[];
  lifecycleNote: string;
};

export type ClawAuditRole = "operator" | "system" | "planner" | "runner" | "verifier" | "helper";

export type ClawAuditSideEffectClass =
  | "local_read_only"
  | "local_mutation"
  | "process_control"
  | "browser_navigation"
  | "browser_mutation"
  | "external_read_only"
  | "external_mutation"
  | "decision_request"
  | "control_change";

export type ClawAuditOutcome =
  | "completed"
  | "requested"
  | "blocked"
  | "failed"
  | "rejected"
  | "resumed";

export type ClawInboxItem = {
  id: string;
  missionId: string;
  missionTitle: string;
  kind: "decision" | "blocker";
  title: string;
  summary: string;
  requestedAt: string;
  status: "pending" | "resolved";
};

export type ClawMissionSummary = {
  id: string;
  title: string;
  goal: string;
  status: ClawMissionStatus;
  continuationPhase: ClawContinuationPhase | null;
  createdAt: string;
  updatedAt: string;
  approvedAt?: string | null;
  startedAt?: string | null;
  endedAt?: string | null;
  workspaceDir: string;
  missionDir: string;
  flowId?: string | null;
  flowRevision?: number | null;
  flowStatus?: ClawManagedFlowStatus | null;
  currentStep?: string | null;
  blockedSummary?: string | null;
  requiresAttention: boolean;
};

export type ClawMissionDetail = ClawMissionSummary & {
  preflight: ClawPreflightCheck[];
  decisions: ClawPendingDecision[];
  files: ClawMissionFileEntry[];
  packet: ClawMissionPacket;
  artifactsDir: string;
  logsDir: string;
  auditLogPath: string;
  auditCount: number;
};

export type ClawAuditEntry = {
  id: string;
  missionId: string;
  at: string;
  actor: "system" | "operator";
  role?: ClawAuditRole | null;
  phase?: ClawMissionStatus | "planning" | null;
  type: string;
  actionType?: string | null;
  toolName?: string | null;
  targetSummary?: string | null;
  sideEffectClass?: ClawAuditSideEffectClass | null;
  intentSummary?: string | null;
  outcome?: ClawAuditOutcome | null;
  errorSummary?: string | null;
  artifactRefs?: string[];
  checkpointRevision?: number | null;
  summary: string;
  detail?: string | null;
};

export type ClawArtifactEntry = {
  name: string;
  path: string;
  kind: "file" | "directory";
  updatedAt?: string | null;
  sizeBytes?: number | null;
};

export type ClawMissionDashboard = {
  missions: ClawMissionSummary[];
  control: ClawControlState;
  inbox: ClawInboxItem[];
};

export type ClawMissionDetailSnapshot = ClawMissionDashboard & {
  mission: ClawMissionDetail | null;
};

export type ClawAuditResult = {
  missionId: string;
  entries: ClawAuditEntry[];
};

export type ClawArtifactsResult = {
  missionId: string;
  artifacts: ClawArtifactEntry[];
};

export const CLAW_MISSION_MARKDOWN_FILES = [
  "MISSION.md",
  "PROJECT_SCOPE.md",
  "PROJECT_PLAN.md",
  "PROJECT_TASKS.md",
  "PROJECT_STATUS.md",
  "PROJECT_DONE_CRITERIA.md",
  "PRECHECKS.md",
  "BLOCKERS.md",
  "DECISIONS.md",
  "ARTIFACTS.md",
] as const;

export type ClawMissionMarkdownFile = (typeof CLAW_MISSION_MARKDOWN_FILES)[number];
