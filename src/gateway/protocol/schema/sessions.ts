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

export const SessionsPatchParamsSchema = Type.Object(
  {
    key: NonEmptyString,
    label: Type.Optional(Type.Union([SessionLabelString, Type.Null()])),
    thinkingLevel: Type.Optional(Type.Union([NonEmptyString, Type.Null()])),
    fastMode: Type.Optional(Type.Union([Type.Boolean(), Type.Null()])),
    verboseLevel: Type.Optional(Type.Union([NonEmptyString, Type.Null()])),
    traceLevel: Type.Optional(Type.Union([NonEmptyString, Type.Null()])),
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
    /**
     * PR-8: toggle plan mode on/off for this session.
     *
     * - `"plan"` arms the runtime mutation gate — write/edit/exec/etc.
     *   are blocked until the user approves a plan via the approval
     *   flow (or the user toggles back to `"normal"`).
     * - `"normal"` clears any pending plan-mode state and unblocks
     *   mutations.
     * - `null` is treated as `"normal"` (consistent with sibling fields'
     *   null-semantics for clearing state).
     *
     * Only the literal mode value is exposed on the wire; the full
     * `PlanModeSessionState` object (approvalId, rejectionCount, etc.)
     * is internal to the server and persisted on `SessionEntry.planMode`.
     */
    planMode: Type.Optional(
      Type.Union([Type.Literal("plan"), Type.Literal("normal"), Type.Null()]),
    ),
    /**
     * PR-8 follow-up: resolve a pending plan approval emitted by
     * `exit_plan_mode`. The action transitions
     * `SessionEntry.planMode.approval` via `resolvePlanApproval` from
     * the plan-mode lib (#67538):
     *
     * - `"approve"` / `"edit"` → mode flips to `"normal"`, mutations unlock.
     * - `"reject"` → mode stays `"plan"`, rejectionCount++, optional
     *   `feedback` is persisted for the agent's next-turn injection.
     *
     * `approvalId` is the version token the runtime emitted with the
     * approval event; the server uses it to ignore stale clicks (e.g.
     * the user clicking Approve on a plan that was already rejected on
     * another surface). When omitted, the server still applies the
     * action — surfaces that don't carry the version token (CLI prompts,
     * legacy channels) get best-effort behavior.
     */
    planApproval: Type.Optional(
      Type.Object(
        {
          action: Type.Union([
            Type.Literal("approve"),
            Type.Literal("reject"),
            Type.Literal("edit"),
          ]),
          feedback: Type.Optional(NonEmptyString),
          approvalId: Type.Optional(NonEmptyString),
        },
        { additionalProperties: false },
      ),
    ),
    /**
     * PR-8 follow-up: the runtime calls `sessions.patch` with
     * `lastPlanSteps` after each `update_plan` tool call so the Control
     * UI can rebuild the live plan-view sidebar after a hard refresh
     * (in-memory UI state is lost otherwise). Persisted to
     * `SessionEntry.planMode.lastPlanSteps` on the server; read by the
     * UI on session subscription mount.
     *
     * Additive protocol change: older clients simply omit the field;
     * older servers silently drop it (no breakage either direction).
     */
    lastPlanSteps: Type.Optional(
      Type.Array(
        Type.Object(
          {
            step: NonEmptyString,
            status: NonEmptyString,
            activeForm: Type.Optional(NonEmptyString),
          },
          { additionalProperties: false },
        ),
      ),
    ),
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
