import { Type, type Static } from "typebox";
import { NonEmptyString } from "./primitives.js";

export const SelfImprovementRecommendationStatusSchema = Type.Union([
  Type.Literal("open"),
  Type.Literal("acknowledged"),
  Type.Literal("assigned"),
  Type.Literal("in_progress"),
  Type.Literal("reopened"),
  Type.Literal("quarantined"),
  Type.Literal("resolved"),
  Type.Literal("dismissed"),
]);

export const SelfImprovementRecommendationSeveritySchema = Type.Union([
  Type.Literal("critical"),
  Type.Literal("high"),
  Type.Literal("medium"),
  Type.Literal("low"),
]);

export const SelfImprovementRecommendationImpactSchema = Type.Union([
  Type.Literal("high"),
  Type.Literal("medium"),
  Type.Literal("low"),
]);

export const SelfImprovementRecommendationEffortSchema = Type.Union([
  Type.Literal("small"),
  Type.Literal("medium"),
  Type.Literal("large"),
]);

export const SelfImprovementRecommendationCategorySchema = Type.Union([
  Type.Literal("task_reliability"),
  Type.Literal("stale_work"),
  Type.Literal("user_correction"),
  Type.Literal("smoke_failure"),
  Type.Literal("model_routing"),
  Type.Literal("skill_workshop"),
  Type.Literal("project_health"),
  Type.Literal("verification_gap"),
  Type.Literal("efficiency_opportunity"),
  Type.Literal("instruction_adherence"),
  Type.Literal("workflow_simplification"),
  Type.Literal("agent_minimization"),
  Type.Literal("capability_evolution"),
  Type.Literal("knowledge_hygiene"),
  Type.Literal("architecture_simplification"),
  Type.Literal("risk_prevention"),
  Type.Literal("outcome_measurement"),
  Type.Literal("major_change"),
]);

export const SelfImprovementRouteRoleSchema = Type.Union([
  Type.Literal("todd"),
  Type.Literal("builder"),
  Type.Literal("qa"),
  Type.Literal("program_manager"),
  Type.Literal("memory_curator"),
]);

export const SelfImprovementReviewModelTierSchema = Type.Union([
  Type.Literal("triage"),
  Type.Literal("primaryReview"),
  Type.Literal("crossCheck"),
  Type.Literal("strategic"),
  Type.Literal("hostedEscalation"),
]);

export const SelfImprovementAnalysisModeSchema = Type.Union([
  Type.Literal("deterministic"),
  Type.Literal("llm"),
  Type.Literal("local_llm"),
  Type.Literal("local_retry"),
  Type.Literal("local_crosscheck"),
  Type.Literal("strategic_local"),
  Type.Literal("hosted_escalation"),
]);

export const SelfImprovementAnalysisRunModeSchema = Type.Union([
  SelfImprovementAnalysisModeSchema,
  Type.Literal("fallback"),
]);

export const SelfImprovementReviewAttemptStatusSchema = Type.Union([
  Type.Literal("success"),
  Type.Literal("invalid_json"),
  Type.Literal("failed"),
  Type.Literal("blocked"),
]);

export const SelfImprovementReviewAttemptDiagnosticSchema = Type.Union([
  Type.Literal("no_balanced_json"),
  Type.Literal("unparseable_json"),
  Type.Literal("missing_group_collection"),
  Type.Literal("empty_groups"),
  Type.Literal("missing_group_id"),
  Type.Literal("unmatched_group_id"),
  Type.Literal("missing_required_fields"),
  Type.Literal("unsafe_fields_after_redaction"),
  Type.Literal("non_object_group"),
  Type.Literal("invalid_review_payload"),
  Type.Literal("unsafe_action"),
  Type.Literal("route_mismatch"),
  Type.Literal("missing_required_evidence"),
  Type.Literal("low_confidence"),
  Type.Literal("overbroad_recommendation"),
  Type.Literal("invented_fact"),
]);

export const SelfImprovementReviewPreflightStatusSchema = Type.Union([
  Type.Literal("not_required"),
  Type.Literal("passed"),
  Type.Literal("missing_config"),
  Type.Literal("unavailable"),
  Type.Literal("skipped"),
]);

export const SelfImprovementReviewPreflightSourceSchema = Type.Union([
  Type.Literal("configured_provider"),
  Type.Literal("default_ollama"),
  Type.Literal("not_required"),
]);

export const SelfImprovementModelReadinessSchema = Type.Union([
  Type.Literal("ready"),
  Type.Literal("degraded"),
  Type.Literal("blocked"),
]);

export const SelfImprovementRecommendationSourceSchema = Type.Object(
  {
    kind: Type.Union([
      Type.Literal("task"),
      Type.Literal("task_group"),
      Type.Literal("cron_job"),
      Type.Literal("skill_workshop"),
      Type.Literal("skill_workshop_queue"),
      Type.Literal("project_health"),
      Type.Literal("configuration"),
      Type.Literal("agent"),
      Type.Literal("instruction"),
      Type.Literal("workflow"),
      Type.Literal("knowledge"),
      Type.Literal("architecture"),
      Type.Literal("risk"),
      Type.Literal("outcome"),
    ]),
    label: Type.String(),
    taskId: Type.Optional(Type.String()),
    runId: Type.Optional(Type.String()),
    agentId: Type.Optional(Type.String()),
    sessionKey: Type.Optional(Type.String()),
    cronJobId: Type.Optional(Type.String()),
    proposalId: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const SelfImprovementRecommendationRouteSchema = Type.Object(
  {
    role: SelfImprovementRouteRoleSchema,
    targetAgentId: NonEmptyString,
    targetAgentLabel: NonEmptyString,
    reason: Type.String(),
  },
  { additionalProperties: false },
);

export const SelfImprovementRecommendationSafetySchema = Type.Object(
  {
    mode: Type.Literal("recommendation_only"),
    mutationAllowed: Type.Literal(false),
    requiresApproval: Type.Boolean(),
    requiresTests: Type.Boolean(),
    blockedActions: Type.Array(Type.String()),
  },
  { additionalProperties: false },
);

export const SelfImprovementActionabilityOwnerStateSchema = Type.Union([
  Type.Literal("unassigned"),
  Type.Literal("assigned"),
  Type.Literal("claimed"),
]);

export const SelfImprovementActionabilitySlaStateSchema = Type.Union([
  Type.Literal("fresh"),
  Type.Literal("aging"),
  Type.Literal("overdue"),
]);

export const SelfImprovementActionabilityProofStateSchema = Type.Union([
  Type.Literal("not_required"),
  Type.Literal("missing"),
  Type.Literal("attached"),
]);

export const SelfImprovementActionabilityClosureStateSchema = Type.Union([
  Type.Literal("blocked"),
  Type.Literal("ready_to_resolve"),
  Type.Literal("closed"),
]);

export const SelfImprovementActionabilitySchema = Type.Object(
  {
    ownerState: SelfImprovementActionabilityOwnerStateSchema,
    slaState: SelfImprovementActionabilitySlaStateSchema,
    proofState: SelfImprovementActionabilityProofStateSchema,
    closureState: SelfImprovementActionabilityClosureStateSchema,
    rank: Type.Integer({ minimum: 0 }),
    ageMs: Type.Integer({ minimum: 0 }),
    slaMs: Type.Integer({ minimum: 1 }),
    dueAt: Type.Integer({ minimum: 0 }),
    overdueMs: Type.Integer({ minimum: 0 }),
    blockers: Type.Array(Type.String()),
    nextAction: Type.String(),
  },
  { additionalProperties: false },
);

export const SelfImprovementRecommendationAnalysisSchema = Type.Object(
  {
    mode: SelfImprovementAnalysisModeSchema,
    summary: Type.String(),
    generatedAt: Type.Integer({ minimum: 0 }),
    confidence: Type.Number({ minimum: 0, maximum: 1 }),
    modelId: Type.Optional(Type.String()),
    modelTier: Type.Optional(SelfImprovementReviewModelTierSchema),
    promptVersion: Type.Optional(Type.String()),
    evidenceCount: Type.Integer({ minimum: 0 }),
    safetyNotes: Type.Array(Type.String()),
    schemaValidated: Type.Optional(Type.Boolean()),
    attemptCount: Type.Optional(Type.Integer({ minimum: 0 })),
    preflightStatus: Type.Optional(SelfImprovementReviewPreflightStatusSchema),
    preflightSource: Type.Optional(SelfImprovementReviewPreflightSourceSchema),
    preflightMs: Type.Optional(Type.Integer({ minimum: 0 })),
    providerConfigured: Type.Optional(Type.Boolean()),
    quantization: Type.Optional(Type.String()),
    parameters: Type.Optional(Type.String()),
    contextWindow: Type.Optional(Type.Integer({ minimum: 0 })),
    escalationReason: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const SelfImprovementProposalStatusSchema = Type.Union([
  Type.Literal("pending"),
  Type.Literal("acknowledged"),
  Type.Literal("approved"),
  Type.Literal("rejected"),
  Type.Literal("superseded"),
]);

export const SelfImprovementCuratorStatusSchema = Type.Union([
  Type.Literal("pending_review"),
  Type.Literal("accepted_for_workshop"),
  Type.Literal("rejected"),
  Type.Literal("needs_more_evidence"),
  Type.Literal("superseded"),
  Type.Literal("promoted"),
]);

export const SelfImprovementProposalKindSchema = Type.Union([
  Type.Literal("implementation"),
  Type.Literal("verification"),
  Type.Literal("sequencing"),
  Type.Literal("memory_skill"),
  Type.Literal("user_synthesis"),
  Type.Literal("major_change"),
  Type.Literal("agentless_alternative"),
]);

export const SelfImprovementAuditEventKindSchema = Type.Union([
  Type.Literal("recommendation_status_updated"),
  Type.Literal("recommendation_group_updated"),
  Type.Literal("background_cycle"),
  Type.Literal("analysis_run"),
  Type.Literal("model_preflight"),
  Type.Literal("reviewer_eval_run"),
  Type.Literal("operational_health_snapshot"),
  Type.Literal("production_check"),
  Type.Literal("retention_maintenance"),
  Type.Literal("proposal_created"),
  Type.Literal("proposal_status_updated"),
  Type.Literal("curator_status_updated"),
  Type.Literal("scorecard_snapshot_written"),
]);

export const SelfImprovementAuditEventActorSchema = Type.Union([
  Type.Literal("governor"),
  Type.Literal("operator"),
  Type.Literal("cli"),
  Type.Literal("gateway"),
]);

export const SelfImprovementAuditEventsListParamsSchema = Type.Object(
  {
    kind: Type.Optional(
      Type.Union([
        SelfImprovementAuditEventKindSchema,
        Type.Array(SelfImprovementAuditEventKindSchema),
      ]),
    ),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
  },
  { additionalProperties: false },
);

export const SelfImprovementRecommendationSchema = Type.Object(
  {
    id: NonEmptyString,
    fingerprint: NonEmptyString,
    createdAt: Type.Integer({ minimum: 0 }),
    updatedAt: Type.Integer({ minimum: 0 }),
    lastSeenAt: Type.Integer({ minimum: 0 }),
    status: SelfImprovementRecommendationStatusSchema,
    title: NonEmptyString,
    summary: Type.String(),
    category: SelfImprovementRecommendationCategorySchema,
    severity: SelfImprovementRecommendationSeveritySchema,
    criticality: SelfImprovementRecommendationSeveritySchema,
    priority: SelfImprovementRecommendationSeveritySchema,
    impact: SelfImprovementRecommendationImpactSchema,
    effort: SelfImprovementRecommendationEffortSchema,
    confidence: Type.Number({ minimum: 0, maximum: 1 }),
    groupKey: NonEmptyString,
    groupTitle: NonEmptyString,
    recurrenceCount: Type.Integer({ minimum: 1 }),
    source: SelfImprovementRecommendationSourceSchema,
    route: SelfImprovementRecommendationRouteSchema,
    assignedTargetAgentId: Type.Optional(Type.String()),
    claimedBy: Type.Optional(Type.String()),
    lastRoutedAt: Type.Optional(Type.Integer({ minimum: 0 })),
    recommendedAction: Type.String(),
    requiredEvidence: Type.Array(Type.String()),
    safety: SelfImprovementRecommendationSafetySchema,
    analysis: SelfImprovementRecommendationAnalysisSchema,
    resolutionProof: Type.Optional(Type.String()),
    dismissalReason: Type.Optional(Type.String()),
    reopenReason: Type.Optional(Type.String()),
    evidence: Type.Array(Type.String()),
    actionability: Type.Optional(SelfImprovementActionabilitySchema),
  },
  { additionalProperties: false },
);

export const SelfImprovementScanParamsSchema = Type.Object(
  {
    includeResolved: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

export const SelfImprovementRecommendationsListParamsSchema = Type.Object(
  {
    status: Type.Optional(
      Type.Union([
        SelfImprovementRecommendationStatusSchema,
        Type.Array(SelfImprovementRecommendationStatusSchema),
      ]),
    ),
    severity: Type.Optional(
      Type.Union([
        SelfImprovementRecommendationSeveritySchema,
        Type.Array(SelfImprovementRecommendationSeveritySchema),
      ]),
    ),
    route: Type.Optional(
      Type.Union([SelfImprovementRouteRoleSchema, Type.Array(SelfImprovementRouteRoleSchema)]),
    ),
    category: Type.Optional(
      Type.Union([
        SelfImprovementRecommendationCategorySchema,
        Type.Array(SelfImprovementRecommendationCategorySchema),
      ]),
    ),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
    cursor: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const SelfImprovementRecommendationsSummaryParamsSchema = Type.Object(
  {
    status: Type.Optional(
      Type.Union([
        SelfImprovementRecommendationStatusSchema,
        Type.Array(SelfImprovementRecommendationStatusSchema),
      ]),
    ),
    route: Type.Optional(
      Type.Union([SelfImprovementRouteRoleSchema, Type.Array(SelfImprovementRouteRoleSchema)]),
    ),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  },
  { additionalProperties: false },
);

export const SelfImprovementScorecardParamsSchema = Type.Object(
  {
    days: Type.Optional(Type.Integer({ minimum: 1, maximum: 90 })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  },
  { additionalProperties: false },
);

export const SelfImprovementHealthParamsSchema = Type.Object(
  {
    days: Type.Optional(Type.Integer({ minimum: 1, maximum: 90 })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  },
  { additionalProperties: false },
);

export const SelfImprovementProductionCheckParamsSchema = Type.Object(
  {
    days: Type.Optional(Type.Integer({ minimum: 1, maximum: 90 })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
    failOnDegraded: Type.Optional(Type.Boolean()),
    failOnBlocked: Type.Optional(Type.Boolean()),
    requireModelReady: Type.Optional(Type.Boolean()),
    requireEvalsReady: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

export const SelfImprovementMaintenanceRunParamsSchema = Type.Object(
  {
    apply: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

export const SelfImprovementRecommendationsGetParamsSchema = Type.Object(
  {
    id: NonEmptyString,
  },
  { additionalProperties: false },
);

export const SelfImprovementRecommendationsUpdateParamsSchema = Type.Object(
  {
    id: NonEmptyString,
    status: SelfImprovementRecommendationStatusSchema,
    note: Type.Optional(Type.String()),
    assignedTargetAgentId: Type.Optional(Type.String()),
    claimedBy: Type.Optional(Type.String()),
    resolutionProof: Type.Optional(Type.String()),
    dismissalReason: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const SelfImprovementGroupsUpdateParamsSchema = Type.Object(
  {
    id: NonEmptyString,
    status: SelfImprovementRecommendationStatusSchema,
    note: Type.Optional(Type.String()),
    assignedTargetAgentId: Type.Optional(Type.String()),
    claimedBy: Type.Optional(Type.String()),
    resolutionProof: Type.Optional(Type.String()),
    dismissalReason: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const SelfImprovementAnalysisRunParamsSchema = Type.Object(
  {
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
    llm: Type.Optional(Type.Boolean()),
    llmApproval: Type.Optional(Type.Boolean()),
    modelId: Type.Optional(Type.String()),
    reviewModelId: Type.Optional(Type.String()),
    fallbackModelId: Type.Optional(Type.String()),
    strategicModelId: Type.Optional(Type.String()),
    localFirst: Type.Optional(Type.Boolean()),
    allowStrategicLocal: Type.Optional(Type.Boolean()),
    allowHostedEscalation: Type.Optional(Type.Boolean()),
    reviewerAgentId: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const SelfImprovementModelPreflightParamsSchema = Type.Object(
  {
    llm: Type.Optional(Type.Boolean()),
    llmApproval: Type.Optional(Type.Boolean()),
    modelId: Type.Optional(Type.String()),
    reviewModelId: Type.Optional(Type.String()),
    fallbackModelId: Type.Optional(Type.String()),
    strategicModelId: Type.Optional(Type.String()),
    localFirst: Type.Optional(Type.Boolean()),
    allowStrategicLocal: Type.Optional(Type.Boolean()),
    allowHostedEscalation: Type.Optional(Type.Boolean()),
    strategic: Type.Optional(Type.Boolean()),
    reviewerAgentId: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const SelfImprovementReviewerEvalFixtureSetSchema = Type.Union([
  Type.Literal("smoke"),
  Type.Literal("core"),
  Type.Literal("all"),
]);

export const SelfImprovementReviewerEvalCategorySchema = Type.Union([
  Type.Literal("schema"),
  Type.Literal("safety"),
  Type.Literal("routing"),
  Type.Literal("evidence"),
  Type.Literal("efficiency"),
  Type.Literal("major_change"),
]);

export const SelfImprovementReviewerEvalRunParamsSchema = Type.Object(
  {
    fixtureSet: Type.Optional(SelfImprovementReviewerEvalFixtureSetSchema),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
    reviewModelId: Type.Optional(Type.String()),
    fallbackModelId: Type.Optional(Type.String()),
    strategicModelId: Type.Optional(Type.String()),
    localFirst: Type.Optional(Type.Boolean()),
    allowStrategicLocal: Type.Optional(Type.Boolean()),
    allowHostedEscalation: Type.Optional(Type.Boolean()),
    llmApproval: Type.Optional(Type.Boolean()),
    reviewerAgentId: Type.Optional(Type.String()),
    failOnThreshold: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

export const SelfImprovementProposalsListParamsSchema = Type.Object(
  {
    status: Type.Optional(
      Type.Union([
        SelfImprovementProposalStatusSchema,
        Type.Array(SelfImprovementProposalStatusSchema),
      ]),
    ),
    kind: Type.Optional(
      Type.Union([
        SelfImprovementProposalKindSchema,
        Type.Array(SelfImprovementProposalKindSchema),
      ]),
    ),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
    cursor: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const SelfImprovementProposalsGetParamsSchema = Type.Object(
  {
    id: NonEmptyString,
  },
  { additionalProperties: false },
);

export const SelfImprovementProposalsUpdateParamsSchema = Type.Object(
  {
    id: NonEmptyString,
    status: SelfImprovementProposalStatusSchema,
    note: Type.Optional(Type.String()),
    approvalProof: Type.Optional(Type.String()),
    dismissalReason: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const SelfImprovementCuratorListParamsSchema = Type.Object(
  {
    status: Type.Optional(
      Type.Union([
        SelfImprovementCuratorStatusSchema,
        Type.Array(SelfImprovementCuratorStatusSchema),
      ]),
    ),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
    cursor: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const SelfImprovementCuratorGetParamsSchema = Type.Object(
  {
    id: NonEmptyString,
  },
  { additionalProperties: false },
);

export const SelfImprovementCuratorUpdateParamsSchema = Type.Object(
  {
    id: NonEmptyString,
    curatorStatus: SelfImprovementCuratorStatusSchema,
    proof: Type.Optional(Type.String()),
    reason: Type.Optional(Type.String()),
    workshopProposalId: Type.Optional(Type.String()),
    workshopProposalStatus: Type.Optional(
      Type.Union([
        Type.Literal("pending"),
        Type.Literal("quarantined"),
        Type.Literal("applied"),
        Type.Literal("rejected"),
      ]),
    ),
    note: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const SelfImprovementScanSummarySchema = Type.Object(
  {
    scannedAt: Type.Integer({ minimum: 0 }),
    trigger: Type.Union([Type.Literal("manual"), Type.Literal("background"), Type.Literal("cli")]),
    inspected: Type.Object(
      {
        tasks: Type.Integer({ minimum: 0 }),
        cronJobs: Type.Integer({ minimum: 0 }),
        auditEvents: Type.Integer({ minimum: 0 }),
        skillWorkshopProposals: Type.Integer({ minimum: 0 }),
      },
      { additionalProperties: false },
    ),
    produced: Type.Integer({ minimum: 0 }),
    created: Type.Integer({ minimum: 0 }),
    updated: Type.Integer({ minimum: 0 }),
    reopened: Type.Integer({ minimum: 0 }),
    total: Type.Integer({ minimum: 0 }),
    open: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);

export const SelfImprovementScanResultSchema = Type.Object(
  {
    scan: SelfImprovementScanSummarySchema,
    recommendations: Type.Array(SelfImprovementRecommendationSchema),
  },
  { additionalProperties: false },
);

export const SelfImprovementRecommendationsListResultSchema = Type.Object(
  {
    recommendations: Type.Array(SelfImprovementRecommendationSchema),
    nextCursor: Type.Optional(Type.String()),
    total: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);

export const SelfImprovementRecommendationGroupSchema = Type.Object(
  {
    id: NonEmptyString,
    groupKey: NonEmptyString,
    title: NonEmptyString,
    category: SelfImprovementRecommendationCategorySchema,
    severity: SelfImprovementRecommendationSeveritySchema,
    criticality: SelfImprovementRecommendationSeveritySchema,
    priority: SelfImprovementRecommendationSeveritySchema,
    status: SelfImprovementRecommendationStatusSchema,
    route: SelfImprovementRecommendationRouteSchema,
    count: Type.Integer({ minimum: 0 }),
    open: Type.Integer({ minimum: 0 }),
    acknowledged: Type.Integer({ minimum: 0 }),
    assigned: Type.Integer({ minimum: 0 }),
    inProgress: Type.Integer({ minimum: 0 }),
    reopened: Type.Integer({ minimum: 0 }),
    quarantined: Type.Integer({ minimum: 0 }),
    resolved: Type.Integer({ minimum: 0 }),
    dismissed: Type.Integer({ minimum: 0 }),
    requiresTests: Type.Boolean(),
    requiresApproval: Type.Boolean(),
    firstSeenAt: Type.Integer({ minimum: 0 }),
    lastSeenAt: Type.Integer({ minimum: 0 }),
    lastUpdatedAt: Type.Integer({ minimum: 0 }),
    recommendationIds: Type.Array(NonEmptyString),
    topEvidence: Type.Array(Type.String()),
    recommendedAction: Type.String(),
    analysis: SelfImprovementRecommendationAnalysisSchema,
    actionability: Type.Optional(SelfImprovementActionabilitySchema),
  },
  { additionalProperties: false },
);

export const SelfImprovementActionQueueItemKindSchema = Type.Union([
  Type.Literal("recommendation"),
  Type.Literal("group"),
]);

export const SelfImprovementActionQueueItemSchema = Type.Object(
  {
    kind: SelfImprovementActionQueueItemKindSchema,
    id: NonEmptyString,
    title: NonEmptyString,
    status: SelfImprovementRecommendationStatusSchema,
    priority: SelfImprovementRecommendationSeveritySchema,
    route: SelfImprovementRecommendationRouteSchema,
    actionability: SelfImprovementActionabilitySchema,
  },
  { additionalProperties: false },
);

export const SelfImprovementActionQueueSummarySchema = Type.Object(
  {
    generatedAt: Type.Integer({ minimum: 0 }),
    total: Type.Integer({ minimum: 0 }),
    unassigned: Type.Integer({ minimum: 0 }),
    overdue: Type.Integer({ minimum: 0 }),
    proofMissing: Type.Integer({ minimum: 0 }),
    readyToResolve: Type.Integer({ minimum: 0 }),
    blocked: Type.Integer({ minimum: 0 }),
    items: Type.Array(SelfImprovementActionQueueItemSchema),
  },
  { additionalProperties: false },
);

export const SelfImprovementScorecardBucketSchema = Type.Object(
  {
    key: NonEmptyString,
    label: NonEmptyString,
    count: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);

export const SelfImprovementIntelligenceBucketSchema = Type.Object(
  {
    category: SelfImprovementRecommendationCategorySchema,
    label: NonEmptyString,
    count: Type.Integer({ minimum: 0 }),
    highCritical: Type.Integer({ minimum: 0 }),
    routes: Type.Array(SelfImprovementScorecardBucketSchema),
  },
  { additionalProperties: false },
);

export const SelfImprovementIntelligenceOpportunitySchema = Type.Object(
  {
    id: NonEmptyString,
    title: NonEmptyString,
    category: SelfImprovementRecommendationCategorySchema,
    priority: SelfImprovementRecommendationSeveritySchema,
    route: SelfImprovementRecommendationRouteSchema,
    count: Type.Integer({ minimum: 0 }),
    confidence: Type.Number({ minimum: 0, maximum: 1 }),
    firstSeenAt: Type.Integer({ minimum: 0 }),
    lastSeenAt: Type.Integer({ minimum: 0 }),
    ageMs: Type.Integer({ minimum: 0 }),
    recommendedAction: Type.String(),
    blockers: Type.Array(Type.String()),
  },
  { additionalProperties: false },
);

export const SelfImprovementIntelligenceSummarySchema = Type.Object(
  {
    generatedAt: Type.Integer({ minimum: 0 }),
    total: Type.Integer({ minimum: 0 }),
    highCritical: Type.Integer({ minimum: 0 }),
    requiresApproval: Type.Integer({ minimum: 0 }),
    requiresTests: Type.Integer({ minimum: 0 }),
    byCategory: Type.Array(SelfImprovementIntelligenceBucketSchema),
    topOpportunities: Type.Array(SelfImprovementIntelligenceOpportunitySchema),
    stalePatterns: Type.Array(SelfImprovementIntelligenceOpportunitySchema),
    instructionThemes: Type.Array(SelfImprovementIntelligenceOpportunitySchema),
    simplificationCandidates: Type.Array(SelfImprovementIntelligenceOpportunitySchema),
    majorChangeCandidates: Type.Array(SelfImprovementIntelligenceOpportunitySchema),
    outcomeMetricGaps: Type.Array(SelfImprovementIntelligenceOpportunitySchema),
  },
  { additionalProperties: false },
);

export const SelfImprovementScorecardSchema = Type.Object(
  {
    generatedAt: Type.Integer({ minimum: 0 }),
    totalRecommendations: Type.Integer({ minimum: 0 }),
    activeRecommendations: Type.Integer({ minimum: 0 }),
    groupedRecommendations: Type.Integer({ minimum: 0 }),
    criticalOpen: Type.Integer({ minimum: 0 }),
    highOpen: Type.Integer({ minimum: 0 }),
    testRequired: Type.Integer({ minimum: 0 }),
    approvalRequired: Type.Integer({ minimum: 0 }),
    reopenedLast24h: Type.Integer({ minimum: 0 }),
    resolvedLast24h: Type.Integer({ minimum: 0 }),
    byCategory: Type.Array(SelfImprovementScorecardBucketSchema),
    byRoute: Type.Array(SelfImprovementScorecardBucketSchema),
    needsApproval: Type.Array(SelfImprovementRecommendationGroupSchema),
    whatImproved: Type.Array(SelfImprovementRecommendationGroupSchema),
    whatWorsened: Type.Array(SelfImprovementRecommendationGroupSchema),
    actionQueue: Type.Optional(SelfImprovementActionQueueSummarySchema),
    intelligence: Type.Optional(SelfImprovementIntelligenceSummarySchema),
  },
  { additionalProperties: false },
);

export const SelfImprovementRecommendationsSummaryResultSchema = Type.Object(
  {
    scorecard: SelfImprovementScorecardSchema,
    groups: Type.Array(SelfImprovementRecommendationGroupSchema),
    totalGroups: Type.Integer({ minimum: 0 }),
    actionQueue: Type.Optional(SelfImprovementActionQueueSummarySchema),
  },
  { additionalProperties: false },
);

export const SelfImprovementRecommendationsGetResultSchema = Type.Object(
  {
    recommendation: SelfImprovementRecommendationSchema,
  },
  { additionalProperties: false },
);

export const SelfImprovementRecommendationsUpdateResultSchema = Type.Object(
  {
    recommendation: SelfImprovementRecommendationSchema,
  },
  { additionalProperties: false },
);

export const SelfImprovementDailyScorecardSchema = Type.Object(
  {
    id: NonEmptyString,
    dateKey: NonEmptyString,
    createdAt: Type.Integer({ minimum: 0 }),
    scorecard: SelfImprovementScorecardSchema,
  },
  { additionalProperties: false },
);

export const SelfImprovementScorecardResultSchema = Type.Object(
  {
    current: SelfImprovementScorecardSchema,
    scorecards: Type.Array(SelfImprovementDailyScorecardSchema),
  },
  { additionalProperties: false },
);

export const SelfImprovementProposalSchema = Type.Object(
  {
    id: NonEmptyString,
    createdAt: Type.Integer({ minimum: 0 }),
    updatedAt: Type.Integer({ minimum: 0 }),
    status: SelfImprovementProposalStatusSchema,
    kind: SelfImprovementProposalKindSchema,
    groupId: NonEmptyString,
    groupKey: NonEmptyString,
    title: NonEmptyString,
    summary: Type.String(),
    route: SelfImprovementRecommendationRouteSchema,
    sourceRecommendationIds: Type.Array(NonEmptyString),
    recommendedAction: Type.String(),
    requiredEvidence: Type.Array(Type.String()),
    safetyNotes: Type.Array(Type.String()),
    approvalRequired: Type.Boolean(),
    testsRequired: Type.Boolean(),
    analysisMode: SelfImprovementAnalysisModeSchema,
    dismissalReason: Type.Optional(Type.String()),
    approvalProof: Type.Optional(Type.String()),
    curatorStatus: Type.Optional(SelfImprovementCuratorStatusSchema),
    curatorProof: Type.Optional(Type.String()),
    curatorReason: Type.Optional(Type.String()),
    curatorUpdatedAt: Type.Optional(Type.Integer({ minimum: 0 })),
    workshopProposalId: Type.Optional(Type.String()),
    workshopProposalStatus: Type.Optional(
      Type.Union([
        Type.Literal("pending"),
        Type.Literal("quarantined"),
        Type.Literal("applied"),
        Type.Literal("rejected"),
      ]),
    ),
    promotionProof: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const SelfImprovementAuditEventMetadataValueSchema = Type.Union([
  Type.String(),
  Type.Number(),
  Type.Boolean(),
  Type.Array(Type.String()),
]);

export const SelfImprovementAuditEventSchema = Type.Object(
  {
    id: NonEmptyString,
    createdAt: Type.Integer({ minimum: 0 }),
    kind: SelfImprovementAuditEventKindSchema,
    actor: SelfImprovementAuditEventActorSchema,
    targetId: Type.String(),
    summary: Type.String(),
    metadata: Type.Optional(
      Type.Record(Type.String(), SelfImprovementAuditEventMetadataValueSchema),
    ),
  },
  { additionalProperties: false },
);

export const SelfImprovementOperationalHealthStatusSchema = Type.Union([
  Type.Literal("ready"),
  Type.Literal("degraded"),
  Type.Literal("blocked"),
]);

export const SelfImprovementOperationalHealthTrendSchema = Type.Union([
  Type.Literal("improving"),
  Type.Literal("stable"),
  Type.Literal("worsening"),
  Type.Literal("unknown"),
]);

export const SelfImprovementOperationalHealthDimensionIdSchema = Type.Union([
  Type.Literal("recommendations"),
  Type.Literal("reviewer"),
  Type.Literal("models"),
  Type.Literal("background"),
  Type.Literal("proposals"),
  Type.Literal("verification"),
  Type.Literal("intelligence"),
]);

export const SelfImprovementOperationalHealthMetricSchema = Type.Object(
  {
    key: NonEmptyString,
    label: NonEmptyString,
    value: Type.Union([Type.String(), Type.Number(), Type.Boolean()]),
  },
  { additionalProperties: false },
);

export const SelfImprovementOperationalHealthDimensionSchema = Type.Object(
  {
    id: SelfImprovementOperationalHealthDimensionIdSchema,
    label: NonEmptyString,
    status: SelfImprovementOperationalHealthStatusSchema,
    score: Type.Integer({ minimum: 0, maximum: 100 }),
    summary: Type.String(),
    metrics: Type.Array(SelfImprovementOperationalHealthMetricSchema),
    blockers: Type.Array(Type.String()),
    nextActions: Type.Array(Type.String()),
  },
  { additionalProperties: false },
);

export const SelfImprovementOperationalHealthSchema = Type.Object(
  {
    generatedAt: Type.Integer({ minimum: 0 }),
    status: SelfImprovementOperationalHealthStatusSchema,
    score: Type.Integer({ minimum: 0, maximum: 100 }),
    trend: SelfImprovementOperationalHealthTrendSchema,
    intervalMs: Type.Integer({ minimum: 1 }),
    staleAfterMs: Type.Integer({ minimum: 1 }),
    dimensions: Type.Array(SelfImprovementOperationalHealthDimensionSchema),
    blockers: Type.Array(Type.String()),
    nextActions: Type.Array(Type.String()),
    previousSnapshotId: Type.Optional(Type.String()),
    latestReviewerEvalAt: Type.Optional(Type.Integer({ minimum: 0 })),
    latestModelPreflightAt: Type.Optional(Type.Integer({ minimum: 0 })),
    latestAnalysisAt: Type.Optional(Type.Integer({ minimum: 0 })),
    latestBackgroundAt: Type.Optional(Type.Integer({ minimum: 0 })),
  },
  { additionalProperties: false },
);

export const SelfImprovementOperationalHealthSnapshotSchema = Type.Object(
  {
    id: NonEmptyString,
    createdAt: Type.Integer({ minimum: 0 }),
    health: SelfImprovementOperationalHealthSchema,
  },
  { additionalProperties: false },
);

export const SelfImprovementOperationalHealthResultSchema = Type.Object(
  {
    current: SelfImprovementOperationalHealthSchema,
    snapshots: Type.Array(SelfImprovementOperationalHealthSnapshotSchema),
    latestReviewerEval: Type.Optional(SelfImprovementAuditEventSchema),
    latestModelPreflight: Type.Optional(SelfImprovementAuditEventSchema),
    latestAnalysis: Type.Optional(SelfImprovementAuditEventSchema),
    latestBackground: Type.Optional(SelfImprovementAuditEventSchema),
  },
  { additionalProperties: false },
);

export const SelfImprovementProductionReadinessEvidenceSchema = Type.Object(
  {
    key: NonEmptyString,
    label: NonEmptyString,
    status: SelfImprovementOperationalHealthStatusSchema,
    summary: Type.String(),
    source: NonEmptyString,
    generatedAt: Type.Optional(Type.Integer({ minimum: 0 })),
  },
  { additionalProperties: false },
);

export const SelfImprovementProductionCheckResultSchema = Type.Object(
  {
    checkedAt: Type.Integer({ minimum: 0 }),
    status: SelfImprovementOperationalHealthStatusSchema,
    ready: Type.Boolean(),
    score: Type.Integer({ minimum: 0, maximum: 100 }),
    failOnDegraded: Type.Boolean(),
    failOnBlocked: Type.Boolean(),
    requireModelReady: Type.Boolean(),
    requireEvalsReady: Type.Boolean(),
    blockers: Type.Array(Type.String()),
    warnings: Type.Array(Type.String()),
    nextActions: Type.Array(Type.String()),
    evidence: Type.Array(SelfImprovementProductionReadinessEvidenceSchema),
    health: SelfImprovementOperationalHealthSchema,
  },
  { additionalProperties: false },
);

export const SelfImprovementMaintenanceStoreNameSchema = Type.Union([
  Type.Literal("recommendations"),
  Type.Literal("auditEvents"),
  Type.Literal("healthSnapshots"),
  Type.Literal("scorecards"),
  Type.Literal("proposals"),
]);

export const SelfImprovementMaintenanceStoreResultSchema = Type.Object(
  {
    store: SelfImprovementMaintenanceStoreNameSchema,
    before: Type.Integer({ minimum: 0 }),
    after: Type.Integer({ minimum: 0 }),
    pruned: Type.Integer({ minimum: 0 }),
    retainedActive: Type.Integer({ minimum: 0 }),
    retentionDays: Type.Integer({ minimum: 1 }),
    maxRecords: Type.Integer({ minimum: 1 }),
  },
  { additionalProperties: false },
);

export const SelfImprovementMaintenanceResultSchema = Type.Object(
  {
    maintainedAt: Type.Integer({ minimum: 0 }),
    dryRun: Type.Boolean(),
    applied: Type.Boolean(),
    stores: Type.Array(SelfImprovementMaintenanceStoreResultSchema),
    totalBefore: Type.Integer({ minimum: 0 }),
    totalAfter: Type.Integer({ minimum: 0 }),
    totalPruned: Type.Integer({ minimum: 0 }),
    auditEventId: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const SelfImprovementReviewAttemptSchema = Type.Object(
  {
    attempt: Type.Integer({ minimum: 1 }),
    tier: SelfImprovementReviewModelTierSchema,
    modelId: NonEmptyString,
    status: SelfImprovementReviewAttemptStatusSchema,
    local: Type.Boolean(),
    schemaValidated: Type.Boolean(),
    groupsReviewed: Type.Integer({ minimum: 0 }),
    quantization: Type.Optional(Type.String()),
    parameters: Type.Optional(Type.String()),
    contextWindow: Type.Optional(Type.Integer({ minimum: 0 })),
    maxOutputTokens: Type.Optional(Type.Integer({ minimum: 0 })),
    temperature: Type.Optional(Type.Number()),
    topP: Type.Optional(Type.Number()),
    timeoutMs: Type.Optional(Type.Integer({ minimum: 0 })),
    preflightStatus: Type.Optional(SelfImprovementReviewPreflightStatusSchema),
    preflightSource: Type.Optional(SelfImprovementReviewPreflightSourceSchema),
    preflightMs: Type.Optional(Type.Integer({ minimum: 0 })),
    providerConfigured: Type.Optional(Type.Boolean()),
    completionMs: Type.Optional(Type.Integer({ minimum: 0 })),
    backend: Type.Optional(Type.String()),
    fallbackBackend: Type.Optional(Type.String()),
    escalationReason: Type.Optional(Type.String()),
    diagnostic: Type.Optional(SelfImprovementReviewAttemptDiagnosticSchema),
    error: Type.Optional(Type.String()),
    remediationHint: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const SelfImprovementAnalysisRunResultSchema = Type.Object(
  {
    analyzedAt: Type.Integer({ minimum: 0 }),
    mode: SelfImprovementAnalysisRunModeSchema,
    modelId: Type.Optional(Type.String()),
    ready: Type.Optional(Type.Boolean()),
    readiness: Type.Optional(SelfImprovementModelReadinessSchema),
    readyTier: Type.Optional(SelfImprovementReviewModelTierSchema),
    readyModelId: Type.Optional(Type.String()),
    confidence: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
    reviewPolicy: Type.Union([
      Type.Literal("deterministic"),
      Type.Literal("hosted"),
      Type.Literal("local_first"),
    ]),
    modelTier: Type.Optional(SelfImprovementReviewModelTierSchema),
    reviewModelId: Type.Optional(Type.String()),
    fallbackModelId: Type.Optional(Type.String()),
    strategicModelId: Type.Optional(Type.String()),
    promptVersion: NonEmptyString,
    llmRequested: Type.Boolean(),
    llmApproved: Type.Boolean(),
    localFirst: Type.Boolean(),
    hostedEscalationAllowed: Type.Boolean(),
    strategicLocalAllowed: Type.Boolean(),
    groupsAnalyzed: Type.Integer({ minimum: 0 }),
    groupsReviewedByLlm: Type.Integer({ minimum: 0 }),
    groupsReviewedByLocalLlm: Type.Integer({ minimum: 0 }),
    recommendationsUpdated: Type.Integer({ minimum: 0 }),
    proposalsCreated: Type.Integer({ minimum: 0 }),
    attempts: Type.Array(SelfImprovementReviewAttemptSchema),
    schemaValidated: Type.Boolean(),
    preflightStatus: Type.Optional(SelfImprovementReviewPreflightStatusSchema),
    preflightMs: Type.Optional(Type.Integer({ minimum: 0 })),
    escalationReason: Type.Optional(Type.String()),
    fallbackReason: Type.Optional(Type.String()),
    blockedPrimaryReason: Type.Optional(Type.String()),
    scorecard: SelfImprovementScorecardSchema,
    proposals: Type.Array(SelfImprovementProposalSchema),
  },
  { additionalProperties: false },
);

export const SelfImprovementModelPreflightResultSchema = Type.Object(
  {
    checkedAt: Type.Integer({ minimum: 0 }),
    ready: Type.Boolean(),
    readiness: SelfImprovementModelReadinessSchema,
    readyTier: Type.Optional(SelfImprovementReviewModelTierSchema),
    readyModelId: Type.Optional(Type.String()),
    reviewPolicy: Type.Union([
      Type.Literal("deterministic"),
      Type.Literal("hosted"),
      Type.Literal("local_first"),
    ]),
    reviewModelId: Type.Optional(Type.String()),
    fallbackModelId: Type.Optional(Type.String()),
    strategicModelId: Type.Optional(Type.String()),
    hostedModelId: Type.Optional(Type.String()),
    localFirst: Type.Boolean(),
    hostedEscalationAllowed: Type.Boolean(),
    strategicLocalAllowed: Type.Boolean(),
    strategicRequested: Type.Boolean(),
    attempts: Type.Array(SelfImprovementReviewAttemptSchema),
    preflightStatus: Type.Optional(SelfImprovementReviewPreflightStatusSchema),
    preflightMs: Type.Optional(Type.Integer({ minimum: 0 })),
    schemaValidated: Type.Literal(false),
    escalationReason: Type.Optional(Type.String()),
    fallbackReason: Type.Optional(Type.String()),
    blockedPrimaryReason: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const SelfImprovementReviewerEvalThresholdsSchema = Type.Object(
  {
    schemaValidRate: Type.Number({ minimum: 0, maximum: 1 }),
    safetyPassRate: Type.Number({ minimum: 0, maximum: 1 }),
    routePreservationRate: Type.Number({ minimum: 0, maximum: 1 }),
    p95CompletionMs: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);

export const SelfImprovementReviewerEvalDiagnosticCountSchema = Type.Object(
  {
    code: SelfImprovementReviewAttemptDiagnosticSchema,
    count: Type.Integer({ minimum: 1 }),
  },
  { additionalProperties: false },
);

export const SelfImprovementReviewerEvalScorecardSchema = Type.Object(
  {
    casesTotal: Type.Integer({ minimum: 0 }),
    casesPassed: Type.Integer({ minimum: 0 }),
    passRate: Type.Number({ minimum: 0, maximum: 1 }),
    schemaValidCases: Type.Integer({ minimum: 0 }),
    schemaValidRate: Type.Number({ minimum: 0, maximum: 1 }),
    safetyPassedCases: Type.Integer({ minimum: 0 }),
    safetyPassRate: Type.Number({ minimum: 0, maximum: 1 }),
    routePreservedCases: Type.Integer({ minimum: 0 }),
    routePreservationRate: Type.Number({ minimum: 0, maximum: 1 }),
    invalidJsonCases: Type.Integer({ minimum: 0 }),
    fallbackUsedCases: Type.Integer({ minimum: 0 }),
    averageCompletionMs: Type.Optional(Type.Integer({ minimum: 0 })),
    p95CompletionMs: Type.Optional(Type.Integer({ minimum: 0 })),
    diagnostics: Type.Array(SelfImprovementReviewerEvalDiagnosticCountSchema),
  },
  { additionalProperties: false },
);

export const SelfImprovementReviewerEvalCaseResultSchema = Type.Object(
  {
    caseId: NonEmptyString,
    title: NonEmptyString,
    category: SelfImprovementReviewerEvalCategorySchema,
    fixtureSet: Type.Union([Type.Literal("smoke"), Type.Literal("core")]),
    passed: Type.Boolean(),
    diagnostics: Type.Array(SelfImprovementReviewAttemptDiagnosticSchema),
    schemaValidated: Type.Boolean(),
    safetyPassed: Type.Boolean(),
    routePreserved: Type.Boolean(),
    confidence: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
    modelId: Type.Optional(Type.String()),
    modelTier: Type.Optional(SelfImprovementReviewModelTierSchema),
    mode: SelfImprovementAnalysisRunModeSchema,
    attempts: Type.Array(SelfImprovementReviewAttemptSchema),
    completionMs: Type.Optional(Type.Integer({ minimum: 0 })),
  },
  { additionalProperties: false },
);

export const SelfImprovementReviewerEvalRunResultSchema = Type.Object(
  {
    evaluatedAt: Type.Integer({ minimum: 0 }),
    fixtureSet: SelfImprovementReviewerEvalFixtureSetSchema,
    limited: Type.Boolean(),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
    ready: Type.Boolean(),
    readiness: SelfImprovementModelReadinessSchema,
    reviewPolicy: Type.Union([
      Type.Literal("deterministic"),
      Type.Literal("hosted"),
      Type.Literal("local_first"),
    ]),
    reviewModelId: Type.Optional(Type.String()),
    fallbackModelId: Type.Optional(Type.String()),
    strategicModelId: Type.Optional(Type.String()),
    modelId: Type.Optional(Type.String()),
    modelTier: Type.Optional(SelfImprovementReviewModelTierSchema),
    localFirst: Type.Boolean(),
    hostedEscalationAllowed: Type.Boolean(),
    strategicLocalAllowed: Type.Boolean(),
    schemaValidated: Type.Boolean(),
    thresholds: SelfImprovementReviewerEvalThresholdsSchema,
    scorecard: SelfImprovementReviewerEvalScorecardSchema,
    cases: Type.Array(SelfImprovementReviewerEvalCaseResultSchema),
    attempts: Type.Array(SelfImprovementReviewAttemptSchema),
    auditEventId: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const SelfImprovementGroupsUpdateResultSchema = Type.Object(
  {
    group: SelfImprovementRecommendationGroupSchema,
    recommendations: Type.Array(SelfImprovementRecommendationSchema),
  },
  { additionalProperties: false },
);

export const SelfImprovementProposalsListResultSchema = Type.Object(
  {
    proposals: Type.Array(SelfImprovementProposalSchema),
    nextCursor: Type.Optional(Type.String()),
    total: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);

export const SelfImprovementProposalsGetResultSchema = Type.Object(
  {
    proposal: SelfImprovementProposalSchema,
  },
  { additionalProperties: false },
);

export const SelfImprovementProposalsUpdateResultSchema = Type.Object(
  {
    proposal: SelfImprovementProposalSchema,
  },
  { additionalProperties: false },
);

export const SelfImprovementAuditEventsListResultSchema = Type.Object(
  {
    events: Type.Array(SelfImprovementAuditEventSchema),
    total: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);

export const SelfImprovementCuratorListResultSchema = Type.Object(
  {
    proposals: Type.Array(SelfImprovementProposalSchema),
    nextCursor: Type.Optional(Type.String()),
    total: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);

export const SelfImprovementCuratorGetResultSchema = Type.Object(
  {
    proposal: SelfImprovementProposalSchema,
  },
  { additionalProperties: false },
);

export const SelfImprovementCuratorUpdateResultSchema = Type.Object(
  {
    proposal: SelfImprovementProposalSchema,
  },
  { additionalProperties: false },
);

export type SelfImprovementScanParams = Static<typeof SelfImprovementScanParamsSchema>;
export type SelfImprovementScorecardParams = Static<typeof SelfImprovementScorecardParamsSchema>;
export type SelfImprovementHealthParams = Static<typeof SelfImprovementHealthParamsSchema>;
export type SelfImprovementProductionCheckParams = Static<
  typeof SelfImprovementProductionCheckParamsSchema
>;
export type SelfImprovementMaintenanceRunParams = Static<
  typeof SelfImprovementMaintenanceRunParamsSchema
>;
export type SelfImprovementAnalysisRunParams = Static<
  typeof SelfImprovementAnalysisRunParamsSchema
>;
export type SelfImprovementModelPreflightParams = Static<
  typeof SelfImprovementModelPreflightParamsSchema
>;
export type SelfImprovementReviewerEvalRunParams = Static<
  typeof SelfImprovementReviewerEvalRunParamsSchema
>;
export type SelfImprovementRecommendationsListParams = Static<
  typeof SelfImprovementRecommendationsListParamsSchema
>;
export type SelfImprovementRecommendationsSummaryParams = Static<
  typeof SelfImprovementRecommendationsSummaryParamsSchema
>;
export type SelfImprovementRecommendationsGetParams = Static<
  typeof SelfImprovementRecommendationsGetParamsSchema
>;
export type SelfImprovementRecommendationsUpdateParams = Static<
  typeof SelfImprovementRecommendationsUpdateParamsSchema
>;
export type SelfImprovementGroupsUpdateParams = Static<
  typeof SelfImprovementGroupsUpdateParamsSchema
>;
export type SelfImprovementProposalsListParams = Static<
  typeof SelfImprovementProposalsListParamsSchema
>;
export type SelfImprovementProposalsGetParams = Static<
  typeof SelfImprovementProposalsGetParamsSchema
>;
export type SelfImprovementProposalsUpdateParams = Static<
  typeof SelfImprovementProposalsUpdateParamsSchema
>;
export type SelfImprovementCuratorListParams = Static<
  typeof SelfImprovementCuratorListParamsSchema
>;
export type SelfImprovementCuratorGetParams = Static<typeof SelfImprovementCuratorGetParamsSchema>;
export type SelfImprovementCuratorUpdateParams = Static<
  typeof SelfImprovementCuratorUpdateParamsSchema
>;
export type SelfImprovementAuditEventsListParams = Static<
  typeof SelfImprovementAuditEventsListParamsSchema
>;
export type SelfImprovementRecommendationsListResult = Static<
  typeof SelfImprovementRecommendationsListResultSchema
>;
export type SelfImprovementRecommendationsSummaryResult = Static<
  typeof SelfImprovementRecommendationsSummaryResultSchema
>;
export type SelfImprovementScorecardResult = Static<typeof SelfImprovementScorecardResultSchema>;
export type SelfImprovementOperationalHealthResult = Static<
  typeof SelfImprovementOperationalHealthResultSchema
>;
export type SelfImprovementProductionCheckResult = Static<
  typeof SelfImprovementProductionCheckResultSchema
>;
export type SelfImprovementMaintenanceResult = Static<
  typeof SelfImprovementMaintenanceResultSchema
>;
export type SelfImprovementAnalysisRunResult = Static<
  typeof SelfImprovementAnalysisRunResultSchema
>;
export type SelfImprovementModelPreflightResult = Static<
  typeof SelfImprovementModelPreflightResultSchema
>;
export type SelfImprovementReviewerEvalRunResult = Static<
  typeof SelfImprovementReviewerEvalRunResultSchema
>;
export type SelfImprovementAuditEventsListResult = Static<
  typeof SelfImprovementAuditEventsListResultSchema
>;
export type SelfImprovementCuratorListResult = Static<
  typeof SelfImprovementCuratorListResultSchema
>;
export type SelfImprovementCuratorGetResult = Static<typeof SelfImprovementCuratorGetResultSchema>;
export type SelfImprovementCuratorUpdateResult = Static<
  typeof SelfImprovementCuratorUpdateResultSchema
>;
