import { Type } from "typebox";
import {
  AGENT_INTERNAL_EVENT_SOURCES,
  AGENT_INTERNAL_EVENT_STATUSES,
  AGENT_INTERNAL_EVENT_TYPE_TASK_COMPLETION,
  AGENT_TASK_COMPLETION_DELIVERY_ACTIONS,
  AGENT_TASK_COMPLETION_DELIVERY_STATES,
} from "../../../agents/internal-event-contract.js";
import { InputProvenanceSchema, NonEmptyString, SessionLabelString } from "./primitives.js";

export const AgentGeneratedAttachmentSchema = Type.Object(
  {
    type: Type.Optional(Type.String({ enum: ["image", "audio", "video", "file"] })),
    path: Type.Optional(Type.String()),
    url: Type.Optional(Type.String()),
    mediaUrl: Type.Optional(Type.String()),
    filePath: Type.Optional(Type.String()),
    mimeType: Type.Optional(Type.String()),
    name: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const AgentTaskCompletionQuarantineMetadataSchema = Type.Object(
  {
    artifactId: Type.Optional(Type.String()),
    sha256: Type.String(),
    payloadSha256: Type.Optional(Type.String()),
    payloadHash: Type.Optional(Type.String()),
    sizeBytes: Type.Number({ minimum: 0 }),
    byteCount: Type.Optional(Type.Number({ minimum: 0 })),
    storedSizeBytes: Type.Optional(Type.Number({ minimum: 0 })),
    source: Type.Optional(Type.String()),
    capturedAt: Type.Optional(Type.String()),
    truncated: Type.Optional(Type.Boolean()),
    redacted: Type.Optional(Type.Boolean()),
    reason: Type.Optional(Type.String()),
    storageStatus: Type.Optional(Type.String()),
    payloadStored: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

export const AgentTaskCompletionRawOpenWorkflowMetadataSchema = Type.Object(
  {
    available: Type.Boolean(),
    requiredAction: Type.Literal("open_raw_quarantine_artifact"),
    localOperatorActionRequired: Type.Literal(true),
    warning: Type.String(),
    artifactId: Type.String(),
    payloadHash: Type.String(),
    byteCount: Type.Number({ minimum: 0 }),
    confirmation: Type.Object(
      {
        required: Type.Literal(true),
        artifactId: Type.String(),
        payloadHash: Type.String(),
      },
      { additionalProperties: false },
    ),
    authorization: Type.Object(
      {
        required: Type.Literal(true),
        scope: Type.Literal("local_operator"),
        status: Type.String({ enum: ["not_requested", "denied", "authorized"] }),
      },
      { additionalProperties: false },
    ),
    audit: Type.Object(
      {
        event: Type.Literal("subagent.raw_artifact.open_requested"),
        mode: Type.Literal("metadata_only"),
      },
      { additionalProperties: false },
    ),
    viewer: Type.Object(
      {
        isolation: Type.Literal("outside_ordinary_chat_model_context_compaction"),
        defaultPreview: Type.Literal(false),
        snippets: Type.Literal(false),
        renderedPayload: Type.Literal(false),
        rawDerivedFilename: Type.Literal(false),
      },
      { additionalProperties: false },
    ),
    redactionScan: Type.Object(
      {
        scanned: Type.Literal(true),
        redacted: Type.Boolean(),
        flags: Type.Array(Type.String()),
        rawSnippetStored: Type.Literal(false),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export const AgentTaskCompletionDebugRefsSchema = Type.Object(
  {
    artifactId: Type.Optional(Type.String()),
    payloadHash: Type.Optional(Type.String()),
    resultHash: Type.Optional(Type.String()),
    byteCount: Type.Optional(Type.Number({ minimum: 0 })),
  },
  { additionalProperties: false },
);

export const AgentTaskCompletionPresentationMetadataSchema = Type.Object(
  {
    mode: Type.Literal("status_card"),
    ordinaryChatBubble: Type.String({
      enum: ["suppressed", "allowed_verified_summary"],
    }),
    collapsedByDefault: Type.Boolean(),
    severity: Type.String({ enum: ["success", "warning", "error", "muted"] }),
    labels: Type.Array(Type.String()),
    copyableDebugRefs: Type.Optional(AgentTaskCompletionDebugRefsSchema),
  },
  { additionalProperties: false },
);

export const AgentTaskCompletionDedupeMetadataSchema = Type.Object(
  {
    key: Type.String(),
    resultHash: Type.String(),
    seenCount: Type.Integer({ minimum: 1 }),
    deliveredCount: Type.Optional(Type.Integer({ minimum: 0 })),
    duplicateCount: Type.Integer({ minimum: 0 }),
    suppressedCount: Type.Optional(Type.Integer({ minimum: 0 })),
    backgroundedCount: Type.Optional(Type.Integer({ minimum: 0 })),
    duplicate: Type.Boolean(),
    parentEventSuppressed: Type.Boolean(),
    activeTaskContractId: Type.Optional(Type.String()),
    childRunId: Type.Optional(Type.String()),
    childSessionId: Type.Optional(Type.String()),
    taskId: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const AgentTaskCompletionArtifactMetadataSchema = Type.Object(
  {
    artifactId: Type.String(),
    sha256: Type.Optional(Type.String()),
    sizeBytes: Type.Optional(Type.Number({ minimum: 0 })),
    status: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const AgentTaskCompletionLogMetadataSchema = Type.Object(
  {
    logId: Type.String(),
    sha256: Type.Optional(Type.String()),
    sizeBytes: Type.Optional(Type.Number({ minimum: 0 })),
    status: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const AgentTaskCompletionEvidenceVerifierSchema = Type.Object(
  {
    decision: Type.String({ enum: ["VERIFIED_PASS", "EVIDENCE_UNVERIFIED"] }),
    acceptanceEligible: Type.Boolean(),
    parentObserved: Type.Boolean(),
    observedBy: Type.Optional(Type.String()),
    observedAt: Type.Optional(Type.String()),
    reasons: Type.Array(Type.String()),
    verifiedCommands: Type.Optional(
      Type.Array(
        Type.Object(
          {
            commandId: Type.Optional(Type.String()),
            runId: Type.Optional(Type.String()),
            status: Type.String(),
          },
          { additionalProperties: false },
        ),
      ),
    ),
    verifiedArtifacts: Type.Optional(Type.Array(AgentTaskCompletionArtifactMetadataSchema)),
    verifiedLogs: Type.Optional(Type.Array(AgentTaskCompletionLogMetadataSchema)),
  },
  { additionalProperties: false },
);

export const AgentTaskCompletionStatusCardSchema = Type.Object(
  {
    kind: Type.Literal("subagent_completion_status"),
    schemaVersion: Type.Optional(Type.Integer({ minimum: 1 })),
    normalizedState: Type.Optional(Type.String()),
    classificationLabels: Type.Optional(Type.Array(Type.String())),
    schemaValid: Type.Optional(Type.Boolean()),
    notAcceptanceEvidence: Type.Optional(Type.Boolean()),
    verifierDecision: Type.Optional(Type.String()),
    evidenceParentObserved: Type.Optional(Type.Boolean()),
    evidenceObservedBy: Type.Optional(Type.String()),
    evidenceReasons: Type.Optional(Type.Array(Type.String())),
    labels: Type.Optional(Type.Array(Type.String())),
    presentation: Type.Optional(AgentTaskCompletionPresentationMetadataSchema),
    debugRefs: Type.Optional(AgentTaskCompletionDebugRefsSchema),
    payloadHash: Type.Optional(Type.String()),
    byteCount: Type.Optional(Type.Number({ minimum: 0 })),
    deliveryState: Type.String({ enum: [...AGENT_TASK_COMPLETION_DELIVERY_STATES] }),
    action: Type.String({ enum: [...AGENT_TASK_COMPLETION_DELIVERY_ACTIONS] }),
    transportOutcome: Type.String(),
    contractVerdict: Type.String(),
    acceptanceEligible: Type.Boolean(),
    reasons: Type.Array(Type.String()),
    quarantine: Type.Optional(AgentTaskCompletionQuarantineMetadataSchema),
    rawOpen: Type.Optional(AgentTaskCompletionRawOpenWorkflowMetadataSchema),
    verifiedArtifacts: Type.Optional(Type.Array(AgentTaskCompletionArtifactMetadataSchema)),
    evidenceVerifier: Type.Optional(AgentTaskCompletionEvidenceVerifierSchema),
    rawBodySuppressed: Type.Boolean(),
    userVisibleSuppressed: Type.Optional(Type.Boolean()),
    userVisibleSuppressedReason: Type.Optional(Type.String()),
    dedupe: Type.Optional(AgentTaskCompletionDedupeMetadataSchema),
    activeTask: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    provenance: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  },
  { additionalProperties: false },
);

export const AgentInternalEventSchema = Type.Object(
  {
    type: Type.Literal(AGENT_INTERNAL_EVENT_TYPE_TASK_COMPLETION),
    source: Type.String({ enum: [...AGENT_INTERNAL_EVENT_SOURCES] }),
    childSessionKey: Type.String(),
    childSessionId: Type.Optional(Type.String()),
    announceType: Type.String(),
    taskLabel: Type.String(),
    status: Type.String({ enum: [...AGENT_INTERNAL_EVENT_STATUSES] }),
    statusLabel: Type.String(),
    result: Type.String(),
    attachments: Type.Optional(Type.Array(AgentGeneratedAttachmentSchema)),
    mediaUrls: Type.Optional(Type.Array(Type.String())),
    statsLine: Type.Optional(Type.String()),
    replyInstruction: Type.String(),
    statusCard: Type.Optional(AgentTaskCompletionStatusCardSchema),
  },
  { additionalProperties: false },
);

export const AgentEventSchema = Type.Object(
  {
    runId: NonEmptyString,
    seq: Type.Integer({ minimum: 0 }),
    stream: NonEmptyString,
    ts: Type.Integer({ minimum: 0 }),
    spawnedBy: Type.Optional(NonEmptyString),
    isHeartbeat: Type.Optional(Type.Boolean()),
    data: Type.Record(Type.String(), Type.Unknown()),
  },
  { additionalProperties: false },
);

export const MessageActionToolContextSchema = Type.Object(
  {
    currentChannelId: Type.Optional(Type.String()),
    currentGraphChannelId: Type.Optional(Type.String()),
    currentChannelProvider: Type.Optional(Type.String()),
    currentThreadTs: Type.Optional(Type.String()),
    currentMessageId: Type.Optional(Type.Union([Type.String(), Type.Number()])),
    replyToMode: Type.Optional(
      Type.Union([
        Type.Literal("off"),
        Type.Literal("first"),
        Type.Literal("all"),
        Type.Literal("batched"),
      ]),
    ),
    hasRepliedRef: Type.Optional(
      Type.Object(
        {
          value: Type.Boolean(),
        },
        { additionalProperties: false },
      ),
    ),
    skipCrossContextDecoration: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

export const MessageActionParamsSchema = Type.Object(
  {
    channel: NonEmptyString,
    action: NonEmptyString,
    params: Type.Record(Type.String(), Type.Unknown()),
    accountId: Type.Optional(Type.String()),
    requesterSenderId: Type.Optional(Type.String()),
    // Honored only when the RPC caller has the full operator scope set
    // (shared-secret bearer or `operator.admin`). For narrowly-scoped
    // callers (e.g. `operator.write`-only) the gateway forces this to
    // `false` regardless of the value sent here.
    senderIsOwner: Type.Optional(Type.Boolean()),
    sessionKey: Type.Optional(Type.String()),
    sessionId: Type.Optional(Type.String()),
    inboundTurnKind: Type.Optional(Type.String({ enum: ["user_request", "room_event"] })),
    agentId: Type.Optional(Type.String()),
    toolContext: Type.Optional(MessageActionToolContextSchema),
    idempotencyKey: NonEmptyString,
  },
  { additionalProperties: false },
);

export const SendParamsSchema = Type.Object(
  {
    to: NonEmptyString,
    message: Type.Optional(Type.String()),
    mediaUrl: Type.Optional(Type.String()),
    mediaUrls: Type.Optional(Type.Array(Type.String())),
    asVoice: Type.Optional(Type.Boolean()),
    gifPlayback: Type.Optional(Type.Boolean()),
    channel: Type.Optional(Type.String()),
    accountId: Type.Optional(Type.String()),
    /** Optional agent id for per-agent media root resolution on gateway sends. */
    agentId: Type.Optional(Type.String()),
    /** Reply target message id for native quoted/threaded sends where supported. */
    replyToId: Type.Optional(Type.String()),
    /** Thread id (channel-specific meaning, e.g. Telegram forum topic id). */
    threadId: Type.Optional(Type.String()),
    /** Force document-style media sends where supported. */
    forceDocument: Type.Optional(Type.Boolean()),
    /** Send silently (no notification) where supported. */
    silent: Type.Optional(Type.Boolean()),
    /** Channel-specific parse mode for formatted text. */
    parseMode: Type.Optional(Type.Literal("HTML")),
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
    provider: Type.Optional(Type.String()),
    model: Type.Optional(Type.String()),
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
    // Backward-compatible no-op. Older CLI clients sent this field on gateway
    // agent requests; the gateway accepts but intentionally ignores it.
    cleanupBundleMcpOnRunEnd: Type.Optional(Type.Boolean()),
    modelRun: Type.Optional(Type.Boolean()),
    promptMode: Type.Optional(
      Type.Union([Type.Literal("full"), Type.Literal("minimal"), Type.Literal("none")]),
    ),
    extraSystemPrompt: Type.Optional(Type.String()),
    bootstrapContextMode: Type.Optional(
      Type.Union([Type.Literal("full"), Type.Literal("lightweight")]),
    ),
    bootstrapContextRunKind: Type.Optional(
      Type.Union([Type.Literal("default"), Type.Literal("heartbeat"), Type.Literal("cron")]),
    ),
    acpTurnSource: Type.Optional(Type.Literal("manual_spawn")),
    internalRuntimeHandoffId: Type.Optional(NonEmptyString),
    internalEvents: Type.Optional(Type.Array(AgentInternalEventSchema)),
    inputProvenance: Type.Optional(InputProvenanceSchema),
    sourceReplyDeliveryMode: Type.Optional(
      Type.Union([Type.Literal("automatic"), Type.Literal("message_tool_only")]),
    ),
    voiceWakeTrigger: Type.Optional(Type.String()),
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
    avatarSource: Type.Optional(NonEmptyString),
    avatarStatus: Type.Optional(Type.String({ enum: ["none", "local", "remote", "data"] })),
    avatarReason: Type.Optional(NonEmptyString),
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

export const WakeParamsSchema = Type.Object(
  {
    mode: Type.Union([Type.Literal("now"), Type.Literal("next-heartbeat")]),
    text: NonEmptyString,
    // Typed field; misspelled variants remain opaque metadata because wake
    // senders already rely on additionalProperties.
    sessionKey: Type.Optional(NonEmptyString),
  },
  { additionalProperties: true }, // external wake senders may attach opaque metadata
);
