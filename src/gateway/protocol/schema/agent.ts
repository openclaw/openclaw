import { Type } from "@sinclair/typebox";
import { INPUT_PROVENANCE_KIND_VALUES } from "../../../sessions/input-provenance.js";
import { NonEmptyString, SessionLabelString } from "./primitives.js";

export const AgentInternalEventSchema = Type.Object(
  {
    type: Type.Literal("task_completion"),
    source: Type.String({ enum: ["subagent", "cron"] }),
    childSessionKey: Type.String(),
    childSessionId: Type.Optional(Type.String()),
    announceType: Type.String(),
    taskLabel: Type.String(),
    status: Type.String({ enum: ["ok", "timeout", "error", "unknown"] }),
    statusLabel: Type.String(),
    result: Type.String(),
    statsLine: Type.Optional(Type.String()),
    replyInstruction: Type.String(),
  },
  { additionalProperties: false },
);

export const AgentEventSchema = Type.Object(
  {
    runId: NonEmptyString,
    seq: Type.Integer({ minimum: 0 }),
    stream: NonEmptyString,
    ts: Type.Integer({ minimum: 0 }),
    data: Type.Record(Type.String(), Type.Unknown()),
  },
  { additionalProperties: false },
);

export const SendParamsSchema = Type.Object(
  {
    to: NonEmptyString,
    message: Type.Optional(Type.String()),
    mediaUrl: Type.Optional(Type.String()),
    mediaUrls: Type.Optional(Type.Array(Type.String())),
    gifPlayback: Type.Optional(Type.Boolean()),
    channel: Type.Optional(Type.String()),
    accountId: Type.Optional(Type.String()),
    /** Optional agent id for per-agent media root resolution on gateway sends. */
    agentId: Type.Optional(Type.String()),
    /** Thread id (channel-specific meaning, e.g. Telegram forum topic id). */
    threadId: Type.Optional(Type.String()),
    /** Optional session key for mirroring delivered output back into the transcript. */
    sessionKey: Type.Optional(Type.String()),
    idempotencyKey: NonEmptyString,
  },
  { additionalProperties: false },
);

export const PollParamsSchema = Type.Object(
  {
    to: NonEmptyString,
    question: NonEmptyString,
    options: Type.Array(NonEmptyString, { minItems: 2, maxItems: 12 }),
    maxSelections: Type.Optional(Type.Integer({ minimum: 1, maximum: 12 })),
    /** Poll duration in seconds (channel-specific limits may apply). */
    durationSeconds: Type.Optional(Type.Integer({ minimum: 1, maximum: 604_800 })),
    durationHours: Type.Optional(Type.Integer({ minimum: 1 })),
    /** Send silently (no notification) where supported. */
    silent: Type.Optional(Type.Boolean()),
    /** Poll anonymity where supported (e.g. Telegram polls default to anonymous). */
    isAnonymous: Type.Optional(Type.Boolean()),
    /** Thread id (channel-specific meaning, e.g. Telegram forum topic id). */
    threadId: Type.Optional(Type.String()),
    channel: Type.Optional(Type.String()),
    accountId: Type.Optional(Type.String()),
    idempotencyKey: NonEmptyString,
  },
  { additionalProperties: false },
);

export const AgentParamsSchema = Type.Object(
  {
    message: NonEmptyString,
    agentId: Type.Optional(NonEmptyString),
    to: Type.Optional(Type.String()),
    replyTo: Type.Optional(Type.String()),
    sessionId: Type.Optional(Type.String()),
    sessionKey: Type.Optional(Type.String()),
    thinking: Type.Optional(Type.String()),
    deliver: Type.Optional(Type.Boolean()),
    attachments: Type.Optional(Type.Array(Type.Unknown())),
    channel: Type.Optional(Type.String()),
    replyChannel: Type.Optional(Type.String()),
    accountId: Type.Optional(Type.String()),
    replyAccountId: Type.Optional(Type.String()),
    threadId: Type.Optional(Type.String()),
    groupId: Type.Optional(Type.String()),
    groupChannel: Type.Optional(Type.String()),
    groupSpace: Type.Optional(Type.String()),
    timeout: Type.Optional(Type.Integer({ minimum: 0 })),
    bestEffortDeliver: Type.Optional(Type.Boolean()),
    lane: Type.Optional(Type.String()),
    extraSystemPrompt: Type.Optional(Type.String()),
    internalEvents: Type.Optional(Type.Array(AgentInternalEventSchema)),
    inputProvenance: Type.Optional(
      Type.Object(
        {
          kind: Type.String({ enum: [...INPUT_PROVENANCE_KIND_VALUES] }),
          originSessionId: Type.Optional(Type.String()),
          sourceSessionKey: Type.Optional(Type.String()),
          sourceChannel: Type.Optional(Type.String()),
          sourceTool: Type.Optional(Type.String()),
        },
        { additionalProperties: false },
      ),
    ),
    idempotencyKey: NonEmptyString,
    label: Type.Optional(SessionLabelString),
  },
  { additionalProperties: false },
);

export const AgentIdentityParamsSchema = Type.Object(
  {
    agentId: Type.Optional(NonEmptyString),
    sessionKey: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const AgentIdentityResultSchema = Type.Object(
  {
    agentId: NonEmptyString,
    name: Type.Optional(NonEmptyString),
    avatar: Type.Optional(NonEmptyString),
    emoji: Type.Optional(NonEmptyString),
  },
  { additionalProperties: false },
);

export const AgentWaitParamsSchema = Type.Object(
  {
    runId: NonEmptyString,
    timeoutMs: Type.Optional(Type.Integer({ minimum: 0 })),
  },
  { additionalProperties: false },
);

export const AgentTimelineStepUsageSchema = Type.Object(
  {
    input: Type.Optional(Type.Integer({ minimum: 0 })),
    output: Type.Optional(Type.Integer({ minimum: 0 })),
    cacheRead: Type.Optional(Type.Integer({ minimum: 0 })),
    cacheWrite: Type.Optional(Type.Integer({ minimum: 0 })),
    total: Type.Optional(Type.Integer({ minimum: 0 })),
  },
  { additionalProperties: false },
);

export const AgentTimelineStepSchema = Type.Object(
  {
    spanId: NonEmptyString,
    stepId: NonEmptyString,
    stepIndex: Type.Integer({ minimum: 1 }),
    attempt: Type.Integer({ minimum: 1 }),
    stage: Type.String({ enum: ["plan", "tool", "observation", "replan"] }),
    status: Type.String({ enum: ["running", "ok", "error", "timeout"] }),
    startedAt: Type.Integer({ minimum: 0 }),
    endedAt: Type.Optional(Type.Integer({ minimum: 0 })),
    durationMs: Type.Optional(Type.Integer({ minimum: 0 })),
    sessionKey: Type.Optional(Type.String()),
    provider: Type.Optional(Type.String()),
    model: Type.Optional(Type.String()),
    toolName: Type.Optional(Type.String()),
    toolCallId: Type.Optional(Type.String()),
    usage: Type.Optional(AgentTimelineStepUsageSchema),
    costUsd: Type.Optional(Type.Number({ minimum: 0 })),
    stopReason: Type.Optional(Type.String()),
    failureReason: Type.Optional(Type.String()),
    error: Type.Optional(Type.String()),
    note: Type.Optional(Type.String()),
    silent: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

export const AgentTimelineParamsSchema = Type.Object(
  {
    runId: NonEmptyString,
  },
  { additionalProperties: false },
);

export const AgentTimelineResultSchema = Type.Object(
  {
    runId: NonEmptyString,
    found: Type.Boolean(),
    sessionKey: Type.Optional(Type.String()),
    status: Type.Optional(Type.String({ enum: ["running", "ok", "error", "timeout"] })),
    startedAt: Type.Optional(Type.Integer({ minimum: 0 })),
    endedAt: Type.Optional(Type.Integer({ minimum: 0 })),
    attemptCount: Type.Optional(Type.Integer({ minimum: 0 })),
    totalCostUsd: Type.Optional(Type.Number({ minimum: 0 })),
    spans: Type.Optional(Type.Array(AgentTimelineStepSchema)),
  },
  { additionalProperties: false },
);

export const WakeParamsSchema = Type.Object(
  {
    mode: Type.Union([Type.Literal("now"), Type.Literal("next-heartbeat")]),
    text: NonEmptyString,
  },
  { additionalProperties: false },
);
