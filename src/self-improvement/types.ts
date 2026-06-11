export type SelfImprovementRecommendationStatus =
  | "open"
  | "acknowledged"
  | "assigned"
  | "in_progress"
  | "reopened"
  | "quarantined"
  | "resolved"
  | "dismissed";

export type SelfImprovementRecommendationSeverity = "critical" | "high" | "medium" | "low";

export type SelfImprovementRecommendationImpact = "high" | "medium" | "low";

export type SelfImprovementRecommendationEffort = "small" | "medium" | "large";

export type SelfImprovementRecommendationCategory =
  | "task_reliability"
  | "stale_work"
  | "user_correction"
  | "smoke_failure"
  | "model_routing"
  | "skill_workshop"
  | "project_health"
  | "verification_gap"
  | "efficiency_opportunity"
  | "instruction_adherence"
  | "workflow_simplification"
  | "agent_minimization"
  | "capability_evolution"
  | "knowledge_hygiene"
  | "architecture_simplification"
  | "risk_prevention"
  | "outcome_measurement"
  | "major_change";

export type SelfImprovementRouteRole =
  | "todd"
  | "builder"
  | "qa"
  | "program_manager"
  | "memory_curator";

export type SelfImprovementRecommendationSource = {
  kind:
    | "task"
    | "task_group"
    | "cron_job"
    | "skill_workshop"
    | "skill_workshop_queue"
    | "project_health"
    | "configuration"
    | "agent"
    | "instruction"
    | "workflow"
    | "knowledge"
    | "architecture"
    | "risk"
    | "outcome";
  label: string;
  taskId?: string;
  runId?: string;
  agentId?: string;
  sessionKey?: string;
  cronJobId?: string;
  proposalId?: string;
};

export type SelfImprovementRecommendationRoute = {
  role: SelfImprovementRouteRole;
  targetAgentId: string;
  targetAgentLabel: string;
  reason: string;
};

export type SelfImprovementRecommendationSafety = {
  mode: "recommendation_only";
  mutationAllowed: false;
  requiresApproval: boolean;
  requiresTests: boolean;
  blockedActions: string[];
};

export type SelfImprovementReviewModelTier =
  | "triage"
  | "primaryReview"
  | "crossCheck"
  | "strategic"
  | "hostedEscalation";

export type SelfImprovementAnalysisMode =
  | "deterministic"
  | "llm"
  | "local_llm"
  | "local_retry"
  | "local_crosscheck"
  | "strategic_local"
  | "hosted_escalation";

export type SelfImprovementAnalysisRunMode = SelfImprovementAnalysisMode | "fallback";

export type SelfImprovementReviewAttemptStatus = "success" | "invalid_json" | "failed" | "blocked";

export type SelfImprovementReviewAttemptDiagnostic =
  | "no_balanced_json"
  | "unparseable_json"
  | "missing_group_collection"
  | "empty_groups"
  | "missing_group_id"
  | "unmatched_group_id"
  | "missing_required_fields"
  | "unsafe_fields_after_redaction"
  | "non_object_group"
  | "invalid_review_payload"
  | "unsafe_action"
  | "route_mismatch"
  | "missing_required_evidence"
  | "low_confidence"
  | "overbroad_recommendation"
  | "invented_fact";

export type SelfImprovementReviewPreflightStatus =
  | "not_required"
  | "passed"
  | "missing_config"
  | "unavailable"
  | "skipped";

export type SelfImprovementReviewPreflightSource =
  | "configured_provider"
  | "default_ollama"
  | "not_required";

export type SelfImprovementModelReadiness = "ready" | "degraded" | "blocked";

export type SelfImprovementReviewAttempt = {
  attempt: number;
  tier: SelfImprovementReviewModelTier;
  modelId: string;
  status: SelfImprovementReviewAttemptStatus;
  local: boolean;
  schemaValidated: boolean;
  groupsReviewed: number;
  quantization?: string;
  parameters?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  temperature?: number;
  topP?: number;
  timeoutMs?: number;
  preflightStatus?: SelfImprovementReviewPreflightStatus;
  preflightSource?: SelfImprovementReviewPreflightSource;
  preflightMs?: number;
  providerConfigured?: boolean;
  completionMs?: number;
  backend?: string;
  fallbackBackend?: string;
  escalationReason?: string;
  diagnostic?: SelfImprovementReviewAttemptDiagnostic;
  error?: string;
  remediationHint?: string;
};

export type SelfImprovementRecommendationAnalysis = {
  mode: SelfImprovementAnalysisMode;
  summary: string;
  generatedAt: number;
  confidence: number;
  modelId?: string;
  modelTier?: SelfImprovementReviewModelTier;
  promptVersion?: string;
  evidenceCount: number;
  safetyNotes: string[];
  schemaValidated?: boolean;
  attemptCount?: number;
  preflightStatus?: SelfImprovementReviewPreflightStatus;
  preflightSource?: SelfImprovementReviewPreflightSource;
  preflightMs?: number;
  providerConfigured?: boolean;
  quantization?: string;
  parameters?: string;
  contextWindow?: number;
  escalationReason?: string;
};

export type SelfImprovementRecommendation = {
  id: string;
  fingerprint: string;
  createdAt: number;
  updatedAt: number;
  lastSeenAt: number;
  status: SelfImprovementRecommendationStatus;
  title: string;
  summary: string;
  category: SelfImprovementRecommendationCategory;
  severity: SelfImprovementRecommendationSeverity;
  criticality: SelfImprovementRecommendationSeverity;
  priority: SelfImprovementRecommendationSeverity;
  impact: SelfImprovementRecommendationImpact;
  effort: SelfImprovementRecommendationEffort;
  confidence: number;
  groupKey: string;
  groupTitle: string;
  recurrenceCount: number;
  source: SelfImprovementRecommendationSource;
  route: SelfImprovementRecommendationRoute;
  assignedTargetAgentId?: string;
  claimedBy?: string;
  lastRoutedAt?: number;
  recommendedAction: string;
  requiredEvidence: string[];
  safety: SelfImprovementRecommendationSafety;
  analysis: SelfImprovementRecommendationAnalysis;
  resolutionProof?: string;
  dismissalReason?: string;
  reopenReason?: string;
  evidence: string[];
  actionability?: SelfImprovementActionability;
};

export type SelfImprovementRecommendationStoreFile = {
  version: 2;
  recommendations: SelfImprovementRecommendation[];
};

export type SelfImprovementRecommendationGroup = {
  id: string;
  groupKey: string;
  title: string;
  category: SelfImprovementRecommendationCategory;
  severity: SelfImprovementRecommendationSeverity;
  criticality: SelfImprovementRecommendationSeverity;
  priority: SelfImprovementRecommendationSeverity;
  status: SelfImprovementRecommendationStatus;
  route: SelfImprovementRecommendationRoute;
  count: number;
  open: number;
  acknowledged: number;
  assigned: number;
  inProgress: number;
  reopened: number;
  quarantined: number;
  resolved: number;
  dismissed: number;
  requiresTests: boolean;
  requiresApproval: boolean;
  firstSeenAt: number;
  lastSeenAt: number;
  lastUpdatedAt: number;
  recommendationIds: string[];
  topEvidence: string[];
  recommendedAction: string;
  analysis: SelfImprovementRecommendationAnalysis;
  actionability?: SelfImprovementActionability;
};

export type SelfImprovementActionabilityOwnerState = "unassigned" | "assigned" | "claimed";

export type SelfImprovementActionabilitySlaState = "fresh" | "aging" | "overdue";

export type SelfImprovementActionabilityProofState = "not_required" | "missing" | "attached";

export type SelfImprovementActionabilityClosureState = "blocked" | "ready_to_resolve" | "closed";

export type SelfImprovementActionability = {
  ownerState: SelfImprovementActionabilityOwnerState;
  slaState: SelfImprovementActionabilitySlaState;
  proofState: SelfImprovementActionabilityProofState;
  closureState: SelfImprovementActionabilityClosureState;
  rank: number;
  ageMs: number;
  slaMs: number;
  dueAt: number;
  overdueMs: number;
  blockers: string[];
  nextAction: string;
};

export type SelfImprovementActionQueueItemKind = "recommendation" | "group";

export type SelfImprovementActionQueueItem = {
  kind: SelfImprovementActionQueueItemKind;
  id: string;
  title: string;
  status: SelfImprovementRecommendationStatus;
  priority: SelfImprovementRecommendationSeverity;
  route: SelfImprovementRecommendationRoute;
  actionability: SelfImprovementActionability;
};

export type SelfImprovementActionQueueSummary = {
  generatedAt: number;
  total: number;
  unassigned: number;
  overdue: number;
  proofMissing: number;
  readyToResolve: number;
  blocked: number;
  items: SelfImprovementActionQueueItem[];
};

export type SelfImprovementScorecardBucket = {
  key: string;
  label: string;
  count: number;
};

export type SelfImprovementIntelligenceBucket = {
  category: SelfImprovementRecommendationCategory;
  label: string;
  count: number;
  highCritical: number;
  routes: SelfImprovementScorecardBucket[];
};

export type SelfImprovementIntelligenceOpportunity = {
  id: string;
  title: string;
  category: SelfImprovementRecommendationCategory;
  priority: SelfImprovementRecommendationSeverity;
  route: SelfImprovementRecommendationRoute;
  count: number;
  confidence: number;
  firstSeenAt: number;
  lastSeenAt: number;
  ageMs: number;
  recommendedAction: string;
  blockers: string[];
};

export type SelfImprovementIntelligenceSummary = {
  generatedAt: number;
  total: number;
  highCritical: number;
  requiresApproval: number;
  requiresTests: number;
  byCategory: SelfImprovementIntelligenceBucket[];
  topOpportunities: SelfImprovementIntelligenceOpportunity[];
  stalePatterns: SelfImprovementIntelligenceOpportunity[];
  instructionThemes: SelfImprovementIntelligenceOpportunity[];
  simplificationCandidates: SelfImprovementIntelligenceOpportunity[];
  majorChangeCandidates: SelfImprovementIntelligenceOpportunity[];
  outcomeMetricGaps: SelfImprovementIntelligenceOpportunity[];
};

export type SelfImprovementScorecard = {
  generatedAt: number;
  totalRecommendations: number;
  activeRecommendations: number;
  groupedRecommendations: number;
  criticalOpen: number;
  highOpen: number;
  testRequired: number;
  approvalRequired: number;
  reopenedLast24h: number;
  resolvedLast24h: number;
  byCategory: SelfImprovementScorecardBucket[];
  byRoute: SelfImprovementScorecardBucket[];
  needsApproval: SelfImprovementRecommendationGroup[];
  whatImproved: SelfImprovementRecommendationGroup[];
  whatWorsened: SelfImprovementRecommendationGroup[];
  actionQueue?: SelfImprovementActionQueueSummary;
  intelligence?: SelfImprovementIntelligenceSummary;
};

export type SelfImprovementSummaryResult = {
  scorecard: SelfImprovementScorecard;
  groups: SelfImprovementRecommendationGroup[];
  totalGroups: number;
  actionQueue?: SelfImprovementActionQueueSummary;
};

export type SelfImprovementScorecardResult = {
  current: SelfImprovementScorecard;
  scorecards: SelfImprovementDailyScorecard[];
};

export type SelfImprovementProposalStatus =
  | "pending"
  | "acknowledged"
  | "approved"
  | "rejected"
  | "superseded";

export type SelfImprovementCuratorStatus =
  | "pending_review"
  | "accepted_for_workshop"
  | "rejected"
  | "needs_more_evidence"
  | "superseded"
  | "promoted";

export type SelfImprovementProposalKind =
  | "implementation"
  | "verification"
  | "sequencing"
  | "memory_skill"
  | "user_synthesis"
  | "major_change"
  | "agentless_alternative";

export type SelfImprovementProposal = {
  id: string;
  createdAt: number;
  updatedAt: number;
  status: SelfImprovementProposalStatus;
  kind: SelfImprovementProposalKind;
  groupId: string;
  groupKey: string;
  title: string;
  summary: string;
  route: SelfImprovementRecommendationRoute;
  sourceRecommendationIds: string[];
  recommendedAction: string;
  requiredEvidence: string[];
  safetyNotes: string[];
  approvalRequired: boolean;
  testsRequired: boolean;
  analysisMode: SelfImprovementRecommendationAnalysis["mode"];
  dismissalReason?: string;
  approvalProof?: string;
  curatorStatus?: SelfImprovementCuratorStatus;
  curatorProof?: string;
  curatorReason?: string;
  curatorUpdatedAt?: number;
  workshopProposalId?: string;
  workshopProposalStatus?: "pending" | "quarantined" | "applied" | "rejected";
  promotionProof?: string;
};

export type SelfImprovementProposalStoreFile = {
  version: 1;
  proposals: SelfImprovementProposal[];
};

export type SelfImprovementAuditEventKind =
  | "recommendation_status_updated"
  | "recommendation_group_updated"
  | "background_cycle"
  | "analysis_run"
  | "model_preflight"
  | "reviewer_eval_run"
  | "operational_health_snapshot"
  | "production_check"
  | "retention_maintenance"
  | "proposal_created"
  | "proposal_status_updated"
  | "curator_status_updated"
  | "scorecard_snapshot_written";

export type SelfImprovementAuditEvent = {
  id: string;
  createdAt: number;
  kind: SelfImprovementAuditEventKind;
  actor: "governor" | "operator" | "cli" | "gateway";
  targetId: string;
  summary: string;
  metadata?: Record<string, string | number | boolean | string[]>;
};

export type SelfImprovementAuditEventStoreFile = {
  version: 1;
  events: SelfImprovementAuditEvent[];
};

export type SelfImprovementDailyScorecard = {
  id: string;
  dateKey: string;
  createdAt: number;
  scorecard: SelfImprovementScorecard;
};

export type SelfImprovementDailyScorecardStoreFile = {
  version: 1;
  scorecards: SelfImprovementDailyScorecard[];
};

export type SelfImprovementOperationalHealthStatus = "ready" | "degraded" | "blocked";

export type SelfImprovementOperationalHealthDimensionId =
  | "recommendations"
  | "reviewer"
  | "models"
  | "background"
  | "proposals"
  | "verification"
  | "intelligence";

export type SelfImprovementOperationalHealthTrend =
  | "improving"
  | "stable"
  | "worsening"
  | "unknown";

export type SelfImprovementOperationalHealthMetric = {
  key: string;
  label: string;
  value: string | number | boolean;
};

export type SelfImprovementOperationalHealthDimension = {
  id: SelfImprovementOperationalHealthDimensionId;
  label: string;
  status: SelfImprovementOperationalHealthStatus;
  score: number;
  summary: string;
  metrics: SelfImprovementOperationalHealthMetric[];
  blockers: string[];
  nextActions: string[];
};

export type SelfImprovementOperationalHealth = {
  generatedAt: number;
  status: SelfImprovementOperationalHealthStatus;
  score: number;
  trend: SelfImprovementOperationalHealthTrend;
  intervalMs: number;
  staleAfterMs: number;
  dimensions: SelfImprovementOperationalHealthDimension[];
  blockers: string[];
  nextActions: string[];
  previousSnapshotId?: string;
  latestReviewerEvalAt?: number;
  latestModelPreflightAt?: number;
  latestAnalysisAt?: number;
  latestBackgroundAt?: number;
};

export type SelfImprovementOperationalHealthSnapshot = {
  id: string;
  createdAt: number;
  health: SelfImprovementOperationalHealth;
};

export type SelfImprovementOperationalHealthSnapshotStoreFile = {
  version: 1;
  snapshots: SelfImprovementOperationalHealthSnapshot[];
};

export type SelfImprovementOperationalHealthResult = {
  current: SelfImprovementOperationalHealth;
  snapshots: SelfImprovementOperationalHealthSnapshot[];
  latestReviewerEval?: SelfImprovementAuditEvent;
  latestModelPreflight?: SelfImprovementAuditEvent;
  latestAnalysis?: SelfImprovementAuditEvent;
  latestBackground?: SelfImprovementAuditEvent;
};

export type SelfImprovementProductionReadinessEvidence = {
  key: string;
  label: string;
  status: SelfImprovementOperationalHealthStatus;
  summary: string;
  source: string;
  generatedAt?: number;
};

export type SelfImprovementProductionCheckResult = {
  checkedAt: number;
  status: SelfImprovementOperationalHealthStatus;
  ready: boolean;
  score: number;
  failOnDegraded: boolean;
  failOnBlocked: boolean;
  requireModelReady: boolean;
  requireEvalsReady: boolean;
  blockers: string[];
  warnings: string[];
  nextActions: string[];
  evidence: SelfImprovementProductionReadinessEvidence[];
  health: SelfImprovementOperationalHealth;
};

export type SelfImprovementMaintenanceStoreName =
  | "recommendations"
  | "auditEvents"
  | "healthSnapshots"
  | "scorecards"
  | "proposals";

export type SelfImprovementMaintenanceStoreResult = {
  store: SelfImprovementMaintenanceStoreName;
  before: number;
  after: number;
  pruned: number;
  retainedActive: number;
  retentionDays: number;
  maxRecords: number;
};

export type SelfImprovementMaintenanceResult = {
  maintainedAt: number;
  dryRun: boolean;
  applied: boolean;
  stores: SelfImprovementMaintenanceStoreResult[];
  totalBefore: number;
  totalAfter: number;
  totalPruned: number;
  auditEventId?: string;
};

export type SelfImprovementAnalysisRunResult = {
  analyzedAt: number;
  mode: SelfImprovementAnalysisRunMode;
  modelId?: string;
  ready?: boolean;
  readiness?: SelfImprovementModelReadiness;
  readyTier?: SelfImprovementReviewModelTier;
  readyModelId?: string;
  confidence?: number;
  reviewPolicy: "deterministic" | "hosted" | "local_first";
  modelTier?: SelfImprovementReviewModelTier;
  reviewModelId?: string;
  fallbackModelId?: string;
  strategicModelId?: string;
  promptVersion: string;
  llmRequested: boolean;
  llmApproved: boolean;
  localFirst: boolean;
  hostedEscalationAllowed: boolean;
  strategicLocalAllowed: boolean;
  groupsAnalyzed: number;
  groupsReviewedByLlm: number;
  groupsReviewedByLocalLlm: number;
  recommendationsUpdated: number;
  proposalsCreated: number;
  attempts: SelfImprovementReviewAttempt[];
  schemaValidated: boolean;
  preflightStatus?: SelfImprovementReviewPreflightStatus;
  preflightMs?: number;
  escalationReason?: string;
  fallbackReason?: string;
  blockedPrimaryReason?: string;
  scorecard: SelfImprovementScorecard;
  proposals: SelfImprovementProposal[];
};

export type SelfImprovementModelPreflightResult = {
  checkedAt: number;
  ready: boolean;
  readiness: SelfImprovementModelReadiness;
  readyTier?: SelfImprovementReviewModelTier;
  readyModelId?: string;
  reviewPolicy: "deterministic" | "hosted" | "local_first";
  reviewModelId?: string;
  fallbackModelId?: string;
  strategicModelId?: string;
  hostedModelId?: string;
  localFirst: boolean;
  hostedEscalationAllowed: boolean;
  strategicLocalAllowed: boolean;
  strategicRequested: boolean;
  attempts: SelfImprovementReviewAttempt[];
  preflightStatus?: SelfImprovementReviewPreflightStatus;
  preflightMs?: number;
  schemaValidated: false;
  escalationReason?: string;
  fallbackReason?: string;
  blockedPrimaryReason?: string;
};

export type SelfImprovementReviewerEvalFixtureSet = "smoke" | "core" | "all";

export type SelfImprovementReviewerEvalCategory =
  | "schema"
  | "safety"
  | "routing"
  | "evidence"
  | "efficiency"
  | "major_change";

export type SelfImprovementReviewerEvalThresholds = {
  schemaValidRate: number;
  safetyPassRate: number;
  routePreservationRate: number;
  p95CompletionMs: number;
};

export type SelfImprovementReviewerEvalCase = {
  id: string;
  title: string;
  category: SelfImprovementReviewerEvalCategory;
  fixtureSet: Exclude<SelfImprovementReviewerEvalFixtureSet, "all">;
  group: SelfImprovementRecommendationGroup;
  expectedRouteRole: SelfImprovementRouteRole;
  minConfidence: number;
  requireTestsEvidence: boolean;
  requireApprovalEvidence: boolean;
  forbiddenTerms: string[];
  forbiddenInventedTerms: string[];
};

export type SelfImprovementReviewerEvalCaseResult = {
  caseId: string;
  title: string;
  category: SelfImprovementReviewerEvalCategory;
  fixtureSet: Exclude<SelfImprovementReviewerEvalFixtureSet, "all">;
  passed: boolean;
  diagnostics: SelfImprovementReviewAttemptDiagnostic[];
  schemaValidated: boolean;
  safetyPassed: boolean;
  routePreserved: boolean;
  confidence?: number;
  modelId?: string;
  modelTier?: SelfImprovementReviewModelTier;
  mode: SelfImprovementAnalysisRunMode;
  attempts: SelfImprovementReviewAttempt[];
  completionMs?: number;
};

export type SelfImprovementReviewerEvalScorecard = {
  casesTotal: number;
  casesPassed: number;
  passRate: number;
  schemaValidCases: number;
  schemaValidRate: number;
  safetyPassedCases: number;
  safetyPassRate: number;
  routePreservedCases: number;
  routePreservationRate: number;
  invalidJsonCases: number;
  fallbackUsedCases: number;
  averageCompletionMs?: number;
  p95CompletionMs?: number;
  diagnostics: Array<{ code: SelfImprovementReviewAttemptDiagnostic; count: number }>;
};

export type SelfImprovementReviewerEvalRunResult = {
  evaluatedAt: number;
  fixtureSet: SelfImprovementReviewerEvalFixtureSet;
  limited: boolean;
  limit?: number;
  ready: boolean;
  readiness: SelfImprovementModelReadiness;
  reviewPolicy: "deterministic" | "hosted" | "local_first";
  reviewModelId?: string;
  fallbackModelId?: string;
  strategicModelId?: string;
  modelId?: string;
  modelTier?: SelfImprovementReviewModelTier;
  localFirst: boolean;
  hostedEscalationAllowed: boolean;
  strategicLocalAllowed: boolean;
  schemaValidated: boolean;
  thresholds: SelfImprovementReviewerEvalThresholds;
  scorecard: SelfImprovementReviewerEvalScorecard;
  cases: SelfImprovementReviewerEvalCaseResult[];
  attempts: SelfImprovementReviewAttempt[];
  auditEventId?: string;
};

export type SelfImprovementScanTrigger = "manual" | "background" | "cli";

export type SelfImprovementScanSummary = {
  scannedAt: number;
  trigger: SelfImprovementScanTrigger;
  inspected: {
    tasks: number;
    cronJobs: number;
    auditEvents: number;
    skillWorkshopProposals: number;
  };
  produced: number;
  created: number;
  updated: number;
  reopened: number;
  total: number;
  open: number;
};

export type SelfImprovementScanResult = {
  scan: SelfImprovementScanSummary;
  recommendations: SelfImprovementRecommendation[];
};
