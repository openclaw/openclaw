import { Type } from "@sinclair/typebox";
import { NonEmptyString, SessionLabelString } from "./primitives.js";

export const SessionCompactionCheckpointReasonSchema = Type.Union([
  Type.Literal("manual"),
  Type.Literal("auto-threshold"),
  Type.Literal("overflow-retry"),
  Type.Literal("timeout-retry"),
]);

export const SessionCompactionTranscriptReferenceSchema = Type.Object(
  {
    sessionId: NonEmptyString,
    sessionFile: Type.Optional(NonEmptyString),
    leafId: Type.Optional(NonEmptyString),
    entryId: Type.Optional(NonEmptyString),
  },
  { additionalProperties: false },
);

export const SessionCompactionCheckpointSchema = Type.Object(
  {
    checkpointId: NonEmptyString,
    sessionKey: NonEmptyString,
    sessionId: NonEmptyString,
    createdAt: Type.Integer({ minimum: 0 }),
    reason: SessionCompactionCheckpointReasonSchema,
    tokensBefore: Type.Optional(Type.Integer({ minimum: 0 })),
    tokensAfter: Type.Optional(Type.Integer({ minimum: 0 })),
    summary: Type.Optional(Type.String()),
    firstKeptEntryId: Type.Optional(NonEmptyString),
    preCompaction: SessionCompactionTranscriptReferenceSchema,
    postCompaction: SessionCompactionTranscriptReferenceSchema,
  },
  { additionalProperties: false },
);

export const SessionsListParamsSchema = Type.Object(
  {
    limit: Type.Optional(Type.Integer({ minimum: 1 })),
    activeMinutes: Type.Optional(Type.Integer({ minimum: 1 })),
    includeGlobal: Type.Optional(Type.Boolean()),
    includeUnknown: Type.Optional(Type.Boolean()),
    /**
     * Read first 8KB of each session transcript to derive title from first user message.
     * Performs a file read per session - use `limit` to bound result set on large stores.
     */
    includeDerivedTitles: Type.Optional(Type.Boolean()),
    /**
     * Read last 16KB of each session transcript to extract most recent message preview.
     * Performs a file read per session - use `limit` to bound result set on large stores.
     */
    includeLastMessage: Type.Optional(Type.Boolean()),
    label: Type.Optional(SessionLabelString),
    spawnedBy: Type.Optional(NonEmptyString),
    agentId: Type.Optional(NonEmptyString),
    search: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const SessionsPreviewParamsSchema = Type.Object(
  {
    keys: Type.Array(NonEmptyString, { minItems: 1 }),
    limit: Type.Optional(Type.Integer({ minimum: 1 })),
    maxChars: Type.Optional(Type.Integer({ minimum: 20 })),
  },
  { additionalProperties: false },
);

export const SessionsResolveParamsSchema = Type.Object(
  {
    key: Type.Optional(NonEmptyString),
    sessionId: Type.Optional(NonEmptyString),
    label: Type.Optional(SessionLabelString),
    agentId: Type.Optional(NonEmptyString),
    spawnedBy: Type.Optional(NonEmptyString),
    includeGlobal: Type.Optional(Type.Boolean()),
    includeUnknown: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

export const SessionsCreateParamsSchema = Type.Object(
  {
    key: Type.Optional(NonEmptyString),
    agentId: Type.Optional(NonEmptyString),
    label: Type.Optional(SessionLabelString),
    model: Type.Optional(NonEmptyString),
    parentSessionKey: Type.Optional(NonEmptyString),
    task: Type.Optional(Type.String()),
    message: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const SessionsInspectParamsSchema = Type.Object(
  {
    key: NonEmptyString,
  },
  { additionalProperties: false },
);

export const SessionsSendParamsSchema = Type.Object(
  {
    key: NonEmptyString,
    message: Type.String(),
    thinking: Type.Optional(Type.String()),
    attachments: Type.Optional(Type.Array(Type.Unknown())),
    timeoutMs: Type.Optional(Type.Integer({ minimum: 0 })),
    idempotencyKey: Type.Optional(NonEmptyString),
  },
  { additionalProperties: false },
);

export const SessionsMessagesSubscribeParamsSchema = Type.Object(
  {
    key: NonEmptyString,
  },
  { additionalProperties: false },
);

export const SessionsMessagesUnsubscribeParamsSchema = Type.Object(
  {
    key: NonEmptyString,
  },
  { additionalProperties: false },
);

export const SessionsAbortParamsSchema = Type.Object(
  {
    key: NonEmptyString,
    runId: Type.Optional(NonEmptyString),
  },
  { additionalProperties: false },
);

const SessionPlanModeSchema = Type.Union([Type.Literal("active"), Type.Literal("inactive")]);

const SessionPlanArtifactStatusSchema = Type.Union([
  Type.Literal("active"),
  Type.Literal("completed"),
  Type.Literal("cancelled"),
]);

const SessionPlanStepStatusSchema = Type.Union([
  Type.Literal("pending"),
  Type.Literal("in_progress"),
  Type.Literal("completed"),
]);

const SessionPlanArtifactStepSchema = Type.Object(
  {
    step: NonEmptyString,
    status: SessionPlanStepStatusSchema,
  },
  { additionalProperties: false },
);

const SessionPlanArtifactSchema = Type.Object(
  {
    goal: Type.Optional(NonEmptyString),
    notes: Type.Optional(NonEmptyString),
    summary: Type.Optional(NonEmptyString),
    lastExplanation: Type.Optional(NonEmptyString),
    status: Type.Optional(SessionPlanArtifactStatusSchema),
    enteredAt: Type.Optional(Type.Integer({ minimum: 0 })),
    updatedAt: Type.Optional(Type.Integer({ minimum: 0 })),
    approvedAt: Type.Optional(Type.Integer({ minimum: 0 })),
    exitedAt: Type.Optional(Type.Integer({ minimum: 0 })),
    steps: Type.Optional(Type.Array(SessionPlanArtifactStepSchema, { minItems: 1 })),
  },
  { additionalProperties: false },
);

const SessionWorktreeModeSchema = Type.Union([Type.Literal("active"), Type.Literal("inactive")]);

const SessionWorktreeArtifactStatusSchema = Type.Union([
  Type.Literal("active"),
  Type.Literal("closed"),
  Type.Literal("removed"),
  Type.Literal("remove_failed"),
]);

const SessionWorktreeCleanupPolicySchema = Type.Union([
  Type.Literal("keep"),
  Type.Literal("remove"),
]);

const SessionWorktreeArtifactSchema = Type.Object(
  {
    repoRoot: Type.Optional(NonEmptyString),
    worktreeDir: Type.Optional(NonEmptyString),
    branch: Type.Optional(NonEmptyString),
    baseRef: Type.Optional(NonEmptyString),
    requestedName: Type.Optional(NonEmptyString),
    cwdBefore: Type.Optional(NonEmptyString),
    cleanupPolicy: Type.Optional(SessionWorktreeCleanupPolicySchema),
    status: Type.Optional(SessionWorktreeArtifactStatusSchema),
    createdAt: Type.Optional(Type.Integer({ minimum: 0 })),
    updatedAt: Type.Optional(Type.Integer({ minimum: 0 })),
    exitedAt: Type.Optional(Type.Integer({ minimum: 0 })),
    lastError: Type.Optional(NonEmptyString),
  },
  { additionalProperties: false },
);

const SessionsControlPlanParamsSchema = Type.Object(
  {
    exit: Type.Optional(Type.Boolean()),
    status: Type.Optional(Type.Union([Type.Literal("completed"), Type.Literal("cancelled")])),
    summary: Type.Optional(Type.String()),
    approved: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

const SessionsControlWorktreeParamsSchema = Type.Object(
  {
    exit: Type.Optional(Type.Boolean()),
    cleanup: Type.Optional(Type.Union([Type.Literal("keep"), Type.Literal("remove")])),
    force: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

const SessionsControlTeamParamsSchema = Type.Object(
  {
    close: Type.Optional(Type.Boolean()),
    teamId: Type.Optional(NonEmptyString),
    summary: Type.Optional(Type.String()),
    cancelActive: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

export const SessionsPatchParamsSchema = Type.Object(
  {
    key: NonEmptyString,
    label: Type.Optional(Type.Union([SessionLabelString, Type.Null()])),
    thinkingLevel: Type.Optional(Type.Union([NonEmptyString, Type.Null()])),
    fastMode: Type.Optional(Type.Union([Type.Boolean(), Type.Null()])),
    verboseLevel: Type.Optional(Type.Union([NonEmptyString, Type.Null()])),
    reasoningLevel: Type.Optional(Type.Union([NonEmptyString, Type.Null()])),
    responseUsage: Type.Optional(
      Type.Union([
        Type.Literal("off"),
        Type.Literal("tokens"),
        Type.Literal("full"),
        // Backward compat with older clients/stores.
        Type.Literal("on"),
        Type.Null(),
      ]),
    ),
    elevatedLevel: Type.Optional(Type.Union([NonEmptyString, Type.Null()])),
    execHost: Type.Optional(Type.Union([NonEmptyString, Type.Null()])),
    execSecurity: Type.Optional(Type.Union([NonEmptyString, Type.Null()])),
    execAsk: Type.Optional(Type.Union([NonEmptyString, Type.Null()])),
    execNode: Type.Optional(Type.Union([NonEmptyString, Type.Null()])),
    model: Type.Optional(Type.Union([NonEmptyString, Type.Null()])),
    spawnedBy: Type.Optional(Type.Union([NonEmptyString, Type.Null()])),
    spawnedWorkspaceDir: Type.Optional(Type.Union([NonEmptyString, Type.Null()])),
    spawnDepth: Type.Optional(Type.Union([Type.Integer({ minimum: 0 }), Type.Null()])),
    subagentRole: Type.Optional(
      Type.Union([Type.Literal("orchestrator"), Type.Literal("leaf"), Type.Null()]),
    ),
    subagentControlScope: Type.Optional(
      Type.Union([Type.Literal("children"), Type.Literal("none"), Type.Null()]),
    ),
    sendPolicy: Type.Optional(
      Type.Union([Type.Literal("allow"), Type.Literal("deny"), Type.Null()]),
    ),
    groupActivation: Type.Optional(
      Type.Union([Type.Literal("mention"), Type.Literal("always"), Type.Null()]),
    ),
    planMode: Type.Optional(Type.Union([SessionPlanModeSchema, Type.Null()])),
    planArtifact: Type.Optional(Type.Union([SessionPlanArtifactSchema, Type.Null()])),
    worktreeMode: Type.Optional(Type.Union([SessionWorktreeModeSchema, Type.Null()])),
    worktreeArtifact: Type.Optional(Type.Union([SessionWorktreeArtifactSchema, Type.Null()])),
  },
  { additionalProperties: false },
);

export const SessionsControlParamsSchema = Type.Object(
  {
    key: NonEmptyString,
    plan: Type.Optional(SessionsControlPlanParamsSchema),
    worktree: Type.Optional(SessionsControlWorktreeParamsSchema),
    team: Type.Optional(SessionsControlTeamParamsSchema),
  },
  { additionalProperties: false },
);

const SessionsInspectSessionSchema = Type.Object(
  {
    key: NonEmptyString,
    sessionId: Type.Optional(Type.Union([NonEmptyString, Type.Null()])),
    updatedAt: Type.Optional(Type.Union([Type.Integer({ minimum: 0 }), Type.Null()])),
    status: Type.Optional(Type.Union([NonEmptyString, Type.Null()])),
    label: Type.Optional(Type.Union([NonEmptyString, Type.Null()])),
    displayName: Type.Optional(Type.Union([NonEmptyString, Type.Null()])),
    modelProvider: Type.Optional(Type.Union([NonEmptyString, Type.Null()])),
    model: Type.Optional(Type.Union([NonEmptyString, Type.Null()])),
    kind: Type.Union([
      Type.Literal("direct"),
      Type.Literal("group"),
      Type.Literal("global"),
      Type.Literal("unknown"),
    ]),
    spawnedBy: Type.Optional(Type.Union([NonEmptyString, Type.Null()])),
    spawnedWorkspaceDir: Type.Optional(Type.Union([NonEmptyString, Type.Null()])),
    parentSessionKey: Type.Optional(Type.Union([NonEmptyString, Type.Null()])),
    spawnDepth: Type.Optional(Type.Union([Type.Integer({ minimum: 0 }), Type.Null()])),
    subagentRole: Type.Optional(
      Type.Union([Type.Literal("orchestrator"), Type.Literal("leaf"), Type.Null()]),
    ),
    subagentControlScope: Type.Optional(
      Type.Union([Type.Literal("children"), Type.Literal("none"), Type.Null()]),
    ),
  },
  { additionalProperties: false },
);

const SessionsInspectPlanSchema = Type.Object(
  {
    mode: Type.Union([SessionPlanModeSchema, Type.Null()]),
    artifact: Type.Union([SessionPlanArtifactSchema, Type.Null()]),
  },
  { additionalProperties: false },
);

const SessionsInspectWorktreeSchema = Type.Object(
  {
    mode: Type.Union([SessionWorktreeModeSchema, Type.Null()]),
    artifact: Type.Union([SessionWorktreeArtifactSchema, Type.Null()]),
    preferredWorkspaceDir: Type.Union([NonEmptyString, Type.Null()]),
  },
  { additionalProperties: false },
);

const TeamMemberStatusSchema = Type.Union([
  Type.Literal("pending"),
  Type.Literal("accepted"),
  Type.Literal("running"),
  Type.Literal("done"),
  Type.Literal("failed"),
  Type.Literal("killed"),
  Type.Literal("timeout"),
  Type.Literal("error"),
]);

const SessionsInspectTeamCountsSchema = Type.Object(
  {
    pending: Type.Integer({ minimum: 0 }),
    accepted: Type.Integer({ minimum: 0 }),
    running: Type.Integer({ minimum: 0 }),
    done: Type.Integer({ minimum: 0 }),
    failed: Type.Integer({ minimum: 0 }),
    killed: Type.Integer({ minimum: 0 }),
    timeout: Type.Integer({ minimum: 0 }),
    error: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);

const SessionsInspectTeamMemberSchema = Type.Object(
  {
    memberId: NonEmptyString,
    label: Type.Optional(Type.Union([NonEmptyString, Type.Null()])),
    task: NonEmptyString,
    status: TeamMemberStatusSchema,
    childSessionKey: Type.Optional(Type.Union([NonEmptyString, Type.Null()])),
    runId: Type.Optional(Type.Union([NonEmptyString, Type.Null()])),
    agentId: Type.Optional(Type.Union([NonEmptyString, Type.Null()])),
    mode: Type.Union([Type.Literal("session"), Type.Literal("task"), Type.Null()]),
    workspaceDir: Type.Optional(Type.Union([NonEmptyString, Type.Null()])),
    error: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    updatedAt: Type.Optional(Type.Union([Type.Integer({ minimum: 0 }), Type.Null()])),
    finishedAt: Type.Optional(Type.Union([Type.Integer({ minimum: 0 }), Type.Null()])),
  },
  { additionalProperties: false },
);

const SessionsInspectTeamSchema = Type.Object(
  {
    teamId: NonEmptyString,
    flowId: NonEmptyString,
    flowStatus: Type.Union([
      Type.Literal("queued"),
      Type.Literal("running"),
      Type.Literal("waiting"),
      Type.Literal("blocked"),
      Type.Literal("succeeded"),
      Type.Literal("failed"),
      Type.Literal("cancelled"),
      Type.Literal("lost"),
    ]),
    currentStep: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    summary: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    worktreeDir: Type.Optional(Type.Union([NonEmptyString, Type.Null()])),
    activeWorkers: Type.Integer({ minimum: 0 }),
    counts: SessionsInspectTeamCountsSchema,
    members: Type.Array(SessionsInspectTeamMemberSchema),
  },
  { additionalProperties: false },
);

const SessionsInspectPolicySchema = Type.Object(
  {
    sendPolicy: Type.Union([Type.Literal("allow"), Type.Literal("deny"), Type.Null()]),
    groupActivation: Type.Union([Type.Literal("mention"), Type.Literal("always"), Type.Null()]),
    execHost: Type.Union([Type.String(), Type.Null()]),
    execSecurity: Type.Union([Type.String(), Type.Null()]),
    execAsk: Type.Union([Type.String(), Type.Null()]),
    execNode: Type.Union([Type.String(), Type.Null()]),
    responseUsage: Type.Union([
      Type.Literal("on"),
      Type.Literal("off"),
      Type.Literal("tokens"),
      Type.Literal("full"),
      Type.Null(),
    ]),
  },
  { additionalProperties: false },
);

const SessionsControlPlanResultSchema = Type.Object(
  {
    mode: SessionPlanModeSchema,
    artifact: Type.Union([SessionPlanArtifactSchema, Type.Null()]),
  },
  { additionalProperties: false },
);

const SessionsControlWorktreeResultSchema = Type.Object(
  {
    status: SessionWorktreeModeSchema,
    cleanup: SessionWorktreeCleanupPolicySchema,
    removed: Type.Boolean(),
    dirty: Type.Boolean(),
    error: Type.Optional(Type.String()),
    previousWorktreeDir: Type.Union([NonEmptyString, Type.Null()]),
    resumedWorkspaceDir: Type.Union([NonEmptyString, Type.Null()]),
    effectiveOnNextTurn: Type.Boolean(),
    artifact: Type.Optional(Type.Union([SessionWorktreeArtifactSchema, Type.Null()])),
  },
  { additionalProperties: false },
);

const SessionsControlActionsSchema = Type.Object(
  {
    plan: Type.Optional(SessionsControlPlanResultSchema),
    worktree: Type.Optional(SessionsControlWorktreeResultSchema),
    team: Type.Optional(SessionsInspectTeamSchema),
  },
  { additionalProperties: false },
);

export const SessionsInspectResultSchema = Type.Object(
  {
    ok: Type.Literal(true),
    key: NonEmptyString,
    exists: Type.Boolean(),
    session: Type.Union([SessionsInspectSessionSchema, Type.Null()]),
    plan: Type.Union([SessionsInspectPlanSchema, Type.Null()]),
    worktree: Type.Union([SessionsInspectWorktreeSchema, Type.Null()]),
    team: Type.Union([SessionsInspectTeamSchema, Type.Null()]),
    policy: Type.Union([SessionsInspectPolicySchema, Type.Null()]),
  },
  { additionalProperties: false },
);

export const SessionsControlResultSchema = Type.Object(
  {
    ok: Type.Literal(true),
    key: NonEmptyString,
    actions: SessionsControlActionsSchema,
  },
  { additionalProperties: false },
);

export const SessionsResetParamsSchema = Type.Object(
  {
    key: NonEmptyString,
    reason: Type.Optional(Type.Union([Type.Literal("new"), Type.Literal("reset")])),
  },
  { additionalProperties: false },
);

export const SessionsDeleteParamsSchema = Type.Object(
  {
    key: NonEmptyString,
    deleteTranscript: Type.Optional(Type.Boolean()),
    // Internal control: when false, still unbind thread bindings but skip hook emission.
    emitLifecycleHooks: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

export const SessionsCompactParamsSchema = Type.Object(
  {
    key: NonEmptyString,
    maxLines: Type.Optional(Type.Integer({ minimum: 1 })),
  },
  { additionalProperties: false },
);

export const SessionsCompactionListParamsSchema = Type.Object(
  {
    key: NonEmptyString,
  },
  { additionalProperties: false },
);

export const SessionsCompactionGetParamsSchema = Type.Object(
  {
    key: NonEmptyString,
    checkpointId: NonEmptyString,
  },
  { additionalProperties: false },
);

export const SessionsCompactionBranchParamsSchema = Type.Object(
  {
    key: NonEmptyString,
    checkpointId: NonEmptyString,
  },
  { additionalProperties: false },
);

export const SessionsCompactionRestoreParamsSchema = Type.Object(
  {
    key: NonEmptyString,
    checkpointId: NonEmptyString,
  },
  { additionalProperties: false },
);

export const SessionsCompactionListResultSchema = Type.Object(
  {
    ok: Type.Literal(true),
    key: NonEmptyString,
    checkpoints: Type.Array(SessionCompactionCheckpointSchema),
  },
  { additionalProperties: false },
);

export const SessionsCompactionGetResultSchema = Type.Object(
  {
    ok: Type.Literal(true),
    key: NonEmptyString,
    checkpoint: SessionCompactionCheckpointSchema,
  },
  { additionalProperties: false },
);

export const SessionsCompactionBranchResultSchema = Type.Object(
  {
    ok: Type.Literal(true),
    sourceKey: NonEmptyString,
    key: NonEmptyString,
    sessionId: NonEmptyString,
    checkpoint: SessionCompactionCheckpointSchema,
    entry: Type.Object(
      {
        sessionId: NonEmptyString,
        updatedAt: Type.Integer({ minimum: 0 }),
      },
      { additionalProperties: true },
    ),
  },
  { additionalProperties: false },
);

export const SessionsCompactionRestoreResultSchema = Type.Object(
  {
    ok: Type.Literal(true),
    key: NonEmptyString,
    sessionId: NonEmptyString,
    checkpoint: SessionCompactionCheckpointSchema,
    entry: Type.Object(
      {
        sessionId: NonEmptyString,
        updatedAt: Type.Integer({ minimum: 0 }),
      },
      { additionalProperties: true },
    ),
  },
  { additionalProperties: false },
);

export const SessionsUsageParamsSchema = Type.Object(
  {
    /** Specific session key to analyze; if omitted returns all sessions. */
    key: Type.Optional(NonEmptyString),
    /** Start date for range filter (YYYY-MM-DD). */
    startDate: Type.Optional(Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" })),
    /** End date for range filter (YYYY-MM-DD). */
    endDate: Type.Optional(Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" })),
    /** How start/end dates should be interpreted. Defaults to UTC when omitted. */
    mode: Type.Optional(
      Type.Union([Type.Literal("utc"), Type.Literal("gateway"), Type.Literal("specific")]),
    ),
    /** UTC offset to use when mode is `specific` (for example, UTC-4 or UTC+5:30). */
    utcOffset: Type.Optional(Type.String({ pattern: "^UTC[+-]\\d{1,2}(?::[0-5]\\d)?$" })),
    /** Maximum sessions to return (default 50). */
    limit: Type.Optional(Type.Integer({ minimum: 1 })),
    /** Include context weight breakdown (systemPromptReport). */
    includeContextWeight: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);
