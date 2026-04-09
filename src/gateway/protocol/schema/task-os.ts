import { Type } from "@sinclair/typebox";
import { NonEmptyString } from "./primitives.js";

const IsoDateTimeString = Type.String({ minLength: 1 });
const TaskDueAtSchema = Type.String({ minLength: 1 });

export const PlanStatusSchema = Type.Union([
  Type.Literal("draft"),
  Type.Literal("active"),
  Type.Literal("completed"),
  Type.Literal("archived"),
]);

export const TaskStatusSchema = Type.Union([
  Type.Literal("pending"),
  Type.Literal("in_progress"),
  Type.Literal("blocked"),
  Type.Literal("completed"),
  Type.Literal("verified"),
]);

export const TaskVerdictSchema = Type.Union([
  Type.Literal("PASS"),
  Type.Literal("FAIL"),
  Type.Literal("PARTIAL"),
]);

export const TaskEvidenceSchema = Type.Object(
  {
    summary: NonEmptyString,
    kind: Type.Optional(Type.String()),
    source: Type.Optional(Type.String()),
    provenanceTier: Type.Optional(
      Type.Union([
        Type.Literal("runtime_evidence"),
        Type.Literal("research_workbench"),
        Type.Literal("durable_memory"),
      ]),
    ),
    promotionStatus: Type.Optional(
      Type.Union([Type.Literal("research_only"), Type.Literal("promoted")]),
    ),
  },
  { additionalProperties: false },
);

export const TaskEvidenceRecordSchema = Type.Object(
  {
    id: NonEmptyString,
    summary: NonEmptyString,
    kind: Type.Optional(Type.String()),
    source: Type.Optional(Type.String()),
    provenanceTier: Type.Optional(
      Type.Union([
        Type.Literal("runtime_evidence"),
        Type.Literal("research_workbench"),
        Type.Literal("durable_memory"),
      ]),
    ),
    promotionStatus: Type.Optional(
      Type.Union([Type.Literal("research_only"), Type.Literal("promoted")]),
    ),
    createdAt: IsoDateTimeString,
  },
  { additionalProperties: false },
);

export const TaskSourceKindSchema = Type.Union([
  Type.Literal("slack"),
  Type.Literal("telegram"),
  Type.Literal("gmail"),
  Type.Literal("jira"),
  Type.Literal("notion"),
  Type.Literal("github"),
  Type.Literal("research"),
]);

export const TaskFingerprintKindSchema = Type.Union([
  Type.Literal("canonical"),
  Type.Literal("source"),
  Type.Literal("idempotency"),
  Type.Literal("external_link"),
]);

export const TaskResolutionStateSchema = Type.Union([
  Type.Literal("open"),
  Type.Literal("resolved"),
  Type.Literal("reopened"),
  Type.Literal("dismissed"),
]);

export const TaskReconciliationStateSchema = Type.Union([
  Type.Literal("canonical"),
  Type.Literal("reconciled"),
  Type.Literal("stale"),
  Type.Literal("conflict"),
]);

export const TaskConfidenceLabelSchema = Type.Union([
  Type.Literal("low"),
  Type.Literal("medium"),
  Type.Literal("high"),
]);

export const TaskArbitrationActionSchema = Type.Union([
  Type.Literal("created"),
  Type.Literal("source_attached"),
  Type.Literal("delivery_deduped"),
  Type.Literal("notification_suppressed"),
  Type.Literal("resolved"),
  Type.Literal("reopened"),
  Type.Literal("reconciled"),
  Type.Literal("stale_marked"),
  Type.Literal("conflict_recorded"),
]);

export const TaskCanonicalUpsertActionSchema = Type.Union([
  Type.Literal("created"),
  Type.Literal("merged"),
  Type.Literal("idempotent"),
]);

export const TaskConfidenceInputSchema = Type.Object(
  {
    score: Type.Optional(Type.Number()),
    reason: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const TaskConfidenceRecordSchema = Type.Object(
  {
    score: Type.Number(),
    label: TaskConfidenceLabelSchema,
    reason: Type.Optional(Type.String()),
    sourceKind: Type.Optional(TaskSourceKindSchema),
    updatedAt: IsoDateTimeString,
  },
  { additionalProperties: false },
);

export const TaskFingerprintRecordSchema = Type.Object(
  {
    kind: TaskFingerprintKindSchema,
    value: NonEmptyString,
    sourceKind: Type.Optional(TaskSourceKindSchema),
    createdAt: IsoDateTimeString,
  },
  { additionalProperties: false },
);

export const TaskExternalLinkInputSchema = Type.Object(
  {
    system: TaskSourceKindSchema,
    externalId: Type.Optional(Type.String()),
    url: Type.Optional(Type.String()),
    title: Type.Optional(Type.String()),
    status: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const TaskExternalLinkRecordSchema = Type.Object(
  {
    id: NonEmptyString,
    system: TaskSourceKindSchema,
    externalId: Type.Optional(Type.String()),
    url: Type.Optional(Type.String()),
    title: Type.Optional(Type.String()),
    status: Type.Optional(Type.String()),
    firstSeenAt: IsoDateTimeString,
    lastSeenAt: IsoDateTimeString,
  },
  { additionalProperties: false },
);

export const TaskSourceProvenanceRecordSchema = Type.Object(
  {
    sourceSurface: Type.Optional(Type.String()),
    sourceId: Type.Optional(Type.String()),
    requestId: Type.Optional(Type.String()),
    idempotencyKey: NonEmptyString,
    truthLayer: NonEmptyString,
    truthRank: Type.Optional(Type.Number()),
    reconciliationMode: Type.Optional(Type.String()),
    allowCandidateTaskCreation: Type.Optional(Type.Boolean()),
    promoteToTaskTruth: Type.Boolean(),
    observedAt: IsoDateTimeString,
  },
  { additionalProperties: false },
);

export const TaskSourceRecordSchema = Type.Object(
  {
    id: NonEmptyString,
    sourceKind: TaskSourceKindSchema,
    signalKind: Type.Optional(Type.String()),
    title: Type.Optional(Type.String()),
    summary: Type.Optional(Type.String()),
    sourceFingerprint: NonEmptyString,
    idempotencyKey: NonEmptyString,
    provenance: TaskSourceProvenanceRecordSchema,
    confidence: Type.Optional(TaskConfidenceRecordSchema),
    externalLinkIds: Type.Array(NonEmptyString),
    firstObservedAt: IsoDateTimeString,
    lastObservedAt: IsoDateTimeString,
    lastResolutionState: Type.Optional(TaskResolutionStateSchema),
  },
  { additionalProperties: false },
);

export const TaskResolutionRecordSchema = Type.Object(
  {
    state: TaskResolutionStateSchema,
    summary: Type.Optional(Type.String()),
    sourceKind: Type.Optional(TaskSourceKindSchema),
    updatedAt: IsoDateTimeString,
    resolvedAt: Type.Optional(IsoDateTimeString),
  },
  { additionalProperties: false },
);

export const TaskReconciliationRecordSchema = Type.Object(
  {
    state: TaskReconciliationStateSchema,
    summary: Type.Optional(Type.String()),
    updatedAt: IsoDateTimeString,
    winnerSourceKind: Type.Optional(TaskSourceKindSchema),
  },
  { additionalProperties: false },
);

export const TaskArbitrationHistoryRecordSchema = Type.Object(
  {
    id: NonEmptyString,
    action: TaskArbitrationActionSchema,
    sourceKind: Type.Optional(TaskSourceKindSchema),
    fingerprint: NonEmptyString,
    summary: NonEmptyString,
    createdAt: IsoDateTimeString,
  },
  { additionalProperties: false },
);

export const TaskCanonicalSourceInputSchema = Type.Object(
  {
    sourceKind: TaskSourceKindSchema,
    signalKind: Type.Optional(Type.String()),
    sourceId: Type.Optional(Type.String()),
    sourceFingerprint: Type.Optional(Type.String()),
    sameWorkKey: Type.Optional(Type.String()),
    idempotencyKey: Type.Optional(Type.String()),
    requestId: Type.Optional(Type.String()),
    sourceSurface: Type.Optional(Type.String()),
    observedAt: Type.Optional(IsoDateTimeString),
    title: Type.Optional(Type.String()),
    summary: Type.Optional(Type.String()),
    confidence: Type.Optional(TaskConfidenceInputSchema),
    externalLinks: Type.Optional(Type.Array(TaskExternalLinkInputSchema)),
    resolutionState: Type.Optional(TaskResolutionStateSchema),
    resolutionSummary: Type.Optional(Type.String()),
    reconciliationState: Type.Optional(TaskReconciliationStateSchema),
  },
  { additionalProperties: false },
);

export const TaskCanonicalWorkInputSchema = Type.Object(
  {
    source: TaskCanonicalSourceInputSchema,
  },
  { additionalProperties: false },
);

export const TaskCanonicalWorkRecordSchema = Type.Object(
  {
    canonicalFingerprint: NonEmptyString,
    fingerprints: Type.Array(TaskFingerprintRecordSchema),
    externalLinks: Type.Array(TaskExternalLinkRecordSchema),
    sources: Type.Array(TaskSourceRecordSchema),
    confidence: Type.Optional(TaskConfidenceRecordSchema),
    resolution: TaskResolutionRecordSchema,
    reconciliation: TaskReconciliationRecordSchema,
    history: Type.Array(TaskArbitrationHistoryRecordSchema),
  },
  { additionalProperties: false },
);

export const TaskVerificationSchema = Type.Object(
  {
    id: NonEmptyString,
    verdict: TaskVerdictSchema,
    summary: Type.Optional(Type.String()),
    evidence: Type.Array(Type.String()),
    actor: Type.Optional(Type.String()),
    verifiedAt: IsoDateTimeString,
  },
  { additionalProperties: false },
);

export const TaskBlockerSchema = Type.Object(
  {
    reason: NonEmptyString,
    blockedBy: Type.Optional(Type.String()),
    blockedAt: IsoDateTimeString,
  },
  { additionalProperties: false },
);

export const PlanRecordSchema = Type.Object(
  {
    id: NonEmptyString,
    title: Type.Optional(Type.String()),
    objective: NonEmptyString,
    approach: Type.Optional(Type.String()),
    acceptanceCriteria: Type.Array(Type.String()),
    status: PlanStatusSchema,
    createdAt: IsoDateTimeString,
    updatedAt: IsoDateTimeString,
  },
  { additionalProperties: false },
);

export const TaskRecordSchema = Type.Object(
  {
    id: NonEmptyString,
    planId: Type.Optional(NonEmptyString),
    title: NonEmptyString,
    description: Type.Optional(Type.String()),
    owner: Type.Optional(Type.String()),
    ownerRole: Type.Optional(Type.String()),
    dueAt: Type.Optional(TaskDueAtSchema),
    status: TaskStatusSchema,
    dependencies: Type.Array(NonEmptyString),
    acceptanceCriteria: Type.Array(Type.String()),
    evidence: Type.Array(TaskEvidenceRecordSchema),
    verificationHistory: Type.Array(TaskVerificationSchema),
    blocker: Type.Optional(TaskBlockerSchema),
    canonicalWork: Type.Optional(TaskCanonicalWorkRecordSchema),
    summary: Type.Optional(Type.String()),
    createdAt: IsoDateTimeString,
    updatedAt: IsoDateTimeString,
    completedAt: Type.Optional(IsoDateTimeString),
    reopenedAt: Type.Optional(IsoDateTimeString),
    verifiedAt: Type.Optional(IsoDateTimeString),
  },
  { additionalProperties: false },
);

export const PlansCreateParamsSchema = Type.Object(
  {
    id: Type.Optional(NonEmptyString),
    title: NonEmptyString,
    objective: NonEmptyString,
    status: Type.Optional(PlanStatusSchema),
    approach: Type.Optional(Type.String()),
    acceptanceCriteria: Type.Optional(Type.Array(Type.String())),
  },
  { additionalProperties: false },
);

export const PlansGetParamsSchema = Type.Object(
  { id: NonEmptyString },
  { additionalProperties: false },
);

export const PlansUpdateParamsSchema = Type.Object(
  {
    id: NonEmptyString,
    patch: Type.Object(
      {
        title: Type.Optional(Type.Union([Type.String(), Type.Null()])),
        objective: Type.Optional(Type.String()),
        status: Type.Optional(PlanStatusSchema),
        approach: Type.Optional(Type.Union([Type.String(), Type.Null()])),
        acceptanceCriteria: Type.Optional(Type.Array(Type.String())),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export const TasksCreateParamsSchema = Type.Object(
  {
    id: Type.Optional(NonEmptyString),
    planId: Type.Optional(NonEmptyString),
    title: NonEmptyString,
    description: Type.Optional(Type.String()),
    owner: Type.Optional(Type.String()),
    ownerRole: Type.Optional(Type.String()),
    dueAt: Type.Optional(TaskDueAtSchema),
    status: Type.Optional(TaskStatusSchema),
    dependencies: Type.Optional(Type.Array(NonEmptyString)),
    acceptanceCriteria: Type.Optional(Type.Array(Type.String())),
    evidence: Type.Optional(Type.Array(TaskEvidenceSchema)),
    canonicalWork: Type.Optional(TaskCanonicalWorkInputSchema),
  },
  { additionalProperties: false },
);

export const TasksUpsertCanonicalParamsSchema = Type.Object(
  {
    id: Type.Optional(NonEmptyString),
    planId: Type.Optional(NonEmptyString),
    title: NonEmptyString,
    description: Type.Optional(Type.String()),
    owner: Type.Optional(Type.String()),
    ownerRole: Type.Optional(Type.String()),
    dueAt: Type.Optional(TaskDueAtSchema),
    status: Type.Optional(TaskStatusSchema),
    dependencies: Type.Optional(Type.Array(NonEmptyString)),
    acceptanceCriteria: Type.Optional(Type.Array(Type.String())),
    evidence: Type.Optional(Type.Array(TaskEvidenceSchema)),
    canonicalWork: TaskCanonicalWorkInputSchema,
  },
  { additionalProperties: false },
);

export const TasksUpdateParamsSchema = Type.Object(
  {
    id: NonEmptyString,
    patch: Type.Object(
      {
        planId: Type.Optional(Type.Union([NonEmptyString, Type.Null()])),
        title: Type.Optional(Type.String()),
        description: Type.Optional(Type.Union([Type.String(), Type.Null()])),
        owner: Type.Optional(Type.Union([Type.String(), Type.Null()])),
        ownerRole: Type.Optional(Type.Union([Type.String(), Type.Null()])),
        dueAt: Type.Optional(Type.Union([TaskDueAtSchema, Type.Null()])),
        status: Type.Optional(TaskStatusSchema),
        dependencies: Type.Optional(Type.Array(NonEmptyString)),
        acceptanceCriteria: Type.Optional(Type.Array(Type.String())),
        summary: Type.Optional(Type.Union([Type.String(), Type.Null()])),
        evidence: Type.Optional(Type.Array(TaskEvidenceSchema)),
        canonicalWork: Type.Optional(TaskCanonicalWorkInputSchema),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export const TasksListParamsSchema = Type.Object(
  {
    planId: Type.Optional(NonEmptyString),
    status: Type.Optional(TaskStatusSchema),
    owner: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const TasksBlockParamsSchema = Type.Object(
  {
    id: NonEmptyString,
    blocker: NonEmptyString,
  },
  { additionalProperties: false },
);

export const TasksCompleteParamsSchema = Type.Object(
  {
    id: NonEmptyString,
    summary: Type.Optional(Type.String()),
    evidence: Type.Optional(Type.Array(TaskEvidenceSchema)),
  },
  { additionalProperties: false },
);

export const TasksVerifyParamsSchema = Type.Object(
  {
    id: NonEmptyString,
    verdict: TaskVerdictSchema,
    summary: Type.Optional(Type.String()),
    evidence: Type.Optional(Type.Array(Type.String())),
    actor: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const TaskResolutionTransitionSchema = Type.Object(
  {
    from: TaskResolutionStateSchema,
    to: TaskResolutionStateSchema,
  },
  { additionalProperties: false },
);

export const TaskReconciliationTransitionSchema = Type.Object(
  {
    from: TaskReconciliationStateSchema,
    to: TaskReconciliationStateSchema,
  },
  { additionalProperties: false },
);

export const TasksUpsertCanonicalResultSchema = Type.Object(
  {
    action: TaskCanonicalUpsertActionSchema,
    task: TaskRecordSchema,
    resolutionTransition: Type.Optional(TaskResolutionTransitionSchema),
    reconciliationTransition: Type.Optional(TaskReconciliationTransitionSchema),
  },
  { additionalProperties: false },
);
