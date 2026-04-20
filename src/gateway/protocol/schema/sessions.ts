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
     * Copilot review #68939 (2026-04-19): scope clarification — this
     * `sessions.patch` INPUT field only accepts the literal mode
     * toggle. The richer persisted plan-mode state (`approvalId`,
     * `rejectionCount`, `lastPlanSteps`, `title`, etc.) is managed
     * server-side on `SessionEntry.planMode` and is NOT writable
     * through this patch field. (It IS surfaced READ-ONLY on
     * `sessions.list`/`sessions.changed` payloads via
     * `GatewaySessionRow.planMode` so the UI mode chip can render
     * the live state — that wire-side exposure is intentional.)
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
     * - `"reject"` → mode stays `"plan"`, rejectionCount++, REQUIRED
     *   `feedback` (1-8192 chars) is persisted for the agent's next-
     *   turn injection. Copilot review #68939 (2026-04-19): the
     *   discriminated union below tightened `feedback` to required
     *   for the reject variant; this bullet was updated to match
     *   so API consumers don't implement against the prior optional
     *   contract.
     *
     * `approvalId` is the version token the runtime emitted with the
     * approval event; the server uses it to ignore stale clicks (e.g.
     * the user clicking Approve on a plan that was already rejected on
     * another surface).
     *
     * Copilot review #68939 (2026-04-19): clarified per-variant
     * approvalId requirement. For `approve`, `edit`, and `reject`,
     * omitting `approvalId` still applies the action on a best-
     * effort basis so surfaces that don't carry the version token
     * (CLI prompts, legacy channels) remain usable. `action:
     * "answer"` is the EXCEPTION: it requires `approvalId`
     * (enforced at the discriminated-union schema layer below) and
     * is rejected without it — the answer-guard in sessions-patch.ts
     * also validates the incoming approvalId against
     * `pendingQuestionApprovalId` server-side. Client implementers
     * should always thread the approvalId for `answer` flows; the
     * other variants degrade gracefully.
     */
    /**
     * Copilot review #68939 (2026-04-19): refactored to a
     * discriminated union keyed on `action`, so each variant
     * encodes its required fields at the schema layer. Pre-fix,
     * all per-action fields were Optional and the runtime had to
     * manually validate (e.g. `action: "answer"` without `answer`,
     * or `action: "auto"` without `autoEnabled`). The runtime
     * checks remain as defense-in-depth but are now unreachable on
     * the happy path because the schema rejects malformed payloads
     * first.
     *
     * Per-variant requirements:
     * - `approve` / `edit`: only `approvalId` (optional but
     *   recommended for staleness protection).
     * - `reject`: optional `feedback` (capped to 8 KiB to bound
     *   the prompt-cache hash explosion vector — PR-11 H4).
     * - `answer`: REQUIRES `answer` text and `approvalId` (Codex P1
     *   review #68939 — the answer-guard validates the approvalId
     *   against `pendingQuestionApprovalId` server-side; clients
     *   that don't thread the version token would otherwise be
     *   able to overwrite a fresh injection with a stale answer).
     * - `auto`: REQUIRES `autoEnabled` boolean (a malformed patch
     *   omitting the field used to coerce to `false` and silently
     *   disable auto-approve — see PR-10 deep-dive review).
     *
     * `action: "edit"` semantic note: still equals "approve with no
     * diff" — the agent executes the ORIGINAL plan. True edit-and-
     * approve (with a modified step list) is deferred to a follow-
     * up PR (PR-8 review fix Codex P1 #3098235203 — Decision C
     * option (b) standing).
     */
    planApproval: Type.Optional(
      Type.Union([
        Type.Object(
          {
            action: Type.Literal("approve"),
            approvalId: Type.Optional(NonEmptyString),
          },
          { additionalProperties: false },
        ),
        Type.Object(
          {
            action: Type.Literal("edit"),
            approvalId: Type.Optional(NonEmptyString),
          },
          { additionalProperties: false },
        ),
        Type.Object(
          {
            action: Type.Literal("reject"),
            // Copilot review #68939 (2026-04-19): made `feedback`
            // REQUIRED for the reject variant (was Optional). The
            // /plan revise <feedback> text-command path already
            // requires feedback (commands-plan.ts validates
            // non-empty at parse time), and the documented UX
            // (`[Reject + Feedback]` button at types.ts:21-23)
            // implies feedback is the whole point of rejection
            // (otherwise the agent has no signal to revise
            // toward). Schema-level requirement closes the
            // loophole where a malformed client / future UI
            // change could submit "reject with no guidance" and
            // leave the agent stuck.
            feedback: Type.String({ minLength: 1, maxLength: 8192 }),
            approvalId: Type.Optional(NonEmptyString),
          },
          { additionalProperties: false },
        ),
        Type.Object(
          {
            action: Type.Literal("answer"),
            answer: Type.String({ minLength: 1, maxLength: 8192 }),
            approvalId: NonEmptyString,
            questionId: Type.Optional(NonEmptyString),
          },
          { additionalProperties: false },
        ),
        Type.Object(
          {
            action: Type.Literal("auto"),
            autoEnabled: Type.Boolean(),
          },
          { additionalProperties: false },
        ),
      ]),
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
            // Copilot review #68939 (2026-04-19): tightened from
            // `NonEmptyString` to a closed enum matching the
            // `PlanStepStatus` runtime type (defined in
            // `src/agents/tools/plan-step-status.ts` and validated
            // by `update_plan`/`exit_plan_mode` at parse time).
            // Pre-fix, an arbitrary status string could be
            // persisted into SessionEntry and rendered by the UI
            // — risking protocol drift, broken close-on-complete
            // detection (which checks `status === "completed"`),
            // and inconsistent plan-card rendering.
            status: Type.Union([
              Type.Literal("pending"),
              Type.Literal("in_progress"),
              Type.Literal("completed"),
              Type.Literal("cancelled"),
            ]),
            activeForm: Type.Optional(NonEmptyString),
            // PR-9 Wave B1 — closure-gate fields (optional, backwards-compatible).
            acceptanceCriteria: Type.Optional(Type.Array(NonEmptyString)),
            verifiedCriteria: Type.Optional(Type.Array(NonEmptyString)),
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
