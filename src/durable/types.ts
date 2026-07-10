// Shared durable runtime control-plane types.
export type DurableRuntimeRunStatus =
  | "accepted"
  | "received"
  | "queued"
  | "running"
  | "waiting"
  | "waiting_signal"
  | "waiting_timer"
  | "waiting_child"
  | "blocked"
  | "retrying"
  | "retry_scheduled"
  | "canceling"
  | "unknown_after_side_effect"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "lost";

export type DurableRecoveryState =
  | "runnable"
  | "claimed"
  | "running"
  | "waiting_signal"
  | "waiting_timer"
  | "waiting_child"
  | "retry_scheduled"
  | "reconciling"
  | "unknown_after_side_effect"
  | "lost"
  | "terminal";

export type DurableRuntimeStepType =
  | "agent"
  | "tool"
  | "timer"
  | "signal"
  | "child_runtime"
  | "checkpoint"
  | "fan_in"
  | "result_mailbox";

export type DurableRuntimeStepStatus =
  | "pending"
  | "queued"
  | "running"
  | "waiting"
  | "retry_scheduled"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "lost"
  | "skipped";

export type DurableRuntimeRefKind = "input" | "output" | "error" | "artifact";

export type DurableRuntimeLinkType =
  | "child_runtime"
  | "handoff"
  | "subagent"
  | "evidence"
  | "artifact";

export type DurableRuntimeLinkStatus =
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "lost";

export type DurableRuntimeTimerStatus = "pending" | "fired" | "cancelled";
export type DurableRuntimeSignalStatus = "pending" | "consumed";

export type DurableParentWakeStatus = "pending" | "delivered" | "acked" | "failed" | "superseded";

export type DurableParentWakeReason =
  | "child_terminal"
  | "fan_in_incomplete"
  | "restart_interrupted"
  | "delivery_unknown"
  | "side_effect_uncertain"
  | "no_handler"
  | "operator_requested";

export type DurableSideEffectUncertaintyKind =
  | "unknown_after_side_effect"
  | "interrupted_during_tool"
  | "lost_after_dispatch"
  | "delivery_unknown"
  | "requires_parent_decision";

export type DurableSideEffectUncertaintyStatus = "open" | "resolved" | "superseded";

export type DurableContinuationCleanupTargetKind =
  | "timer"
  | "signal"
  | "result_mailbox"
  | "wake"
  | "continuation_cursor";

export type DurableContinuationCleanupStatus = "superseded" | "noop";

export type DurableDedupeScope = "wake" | "wake_delivery" | "result_mailbox" | "recovery_pass";

export type DurableDedupeLedgerStatus = "recorded" | "applied" | "conflict" | "superseded";

export type DurableRuntimeRun = {
  runtimeRunId: string;
  operationKind: string;
  operationVersion: string;
  status: DurableRuntimeRunStatus;
  recoveryState: DurableRecoveryState;
  idempotencyKey?: string;
  requestHash?: string;
  sourceType?: string;
  sourceRef?: string;
  inputRef?: string;
  checkpointRef?: string;
  parentRuntimeRunId?: string;
  parentStepId?: string;
  messageId?: string;
  turnId?: string;
  workUnitId?: string;
  reportRouteId?: string;
  claimedBy?: string;
  claimExpiresAt?: number;
  heartbeatAt?: number;
  metadata?: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
};

export type DurableRuntimeStep = {
  runtimeRunId: string;
  stepId: string;
  parentStepId?: string;
  stepType: DurableRuntimeStepType;
  status: DurableRuntimeStepStatus;
  recoveryState: DurableRecoveryState;
  attempt: number;
  maxAttempts?: number;
  idempotencyKey?: string;
  inputRef?: string;
  outputRef?: string;
  errorRef?: string;
  checkpointRef?: string;
  claimedBy?: string;
  claimExpiresAt?: number;
  heartbeatAt?: number;
  metadata?: Record<string, unknown>;
  createdAt: number;
  startedAt?: number;
  updatedAt: number;
  completedAt?: number;
};

export type DurableRuntimeRef = {
  refId: string;
  runtimeRunId: string;
  stepId?: string;
  refKind: DurableRuntimeRefKind;
  mediaType?: string;
  hash?: string;
  storageKind: "inline" | "file" | "external";
  storageUri?: string;
  metadata?: Record<string, unknown>;
  createdAt: number;
};

export type DurableRuntimeLink = {
  parentRuntimeRunId: string;
  parentStepId: string;
  childRuntimeRunId: string;
  linkType: DurableRuntimeLinkType;
  status: DurableRuntimeLinkStatus;
  metadata?: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
};

export type DurableRuntimeTimer = {
  timerId: string;
  runtimeRunId: string;
  stepId?: string;
  timerType: "retry" | "deadline" | "sleep" | "human_timeout" | "child_timeout" | "scheduled_start";
  dueAt: number;
  status: DurableRuntimeTimerStatus;
  metadata?: Record<string, unknown>;
  createdAt: number;
  firedAt?: number;
  cancelledAt?: number;
};

export type DurableRuntimeSignal = {
  signalId: string;
  runtimeRunId: string;
  stepId?: string;
  signalType:
    | "human_input"
    | "approval"
    | "rejection"
    | "external_callback"
    | "child_completed"
    | "child_failed"
    | "cancel"
    | "resume";
  idempotencyKey?: string;
  payloadRef?: string;
  correlationId?: string;
  metadata?: Record<string, unknown>;
  receivedAt: number;
  consumedAt?: number;
};

export type DurableRuntimeEvent = {
  eventId: string;
  runtimeRunId: string;
  eventSeq: number;
  eventType: string;
  eventTime: number;
  stepId?: string;
  agentInvocationId?: string;
  toolInvocationId?: string;
  idempotencyKey?: string;
  payload?: Record<string, unknown>;
  payloadHash?: string;
  checkpointRef?: string;
  causationEventId?: string;
  correlationId?: string;
  recordedAt: number;
};

export type DurableParentWake = {
  wakeId: string;
  parentRunId?: string;
  parentSessionKey?: string;
  targetAgent?: string;
  targetSession?: string;
  targetChannel?: string;
  reason: DurableParentWakeReason;
  factsRef?: string;
  sourceRunId?: string;
  dedupeKey: string;
  attemptCount: number;
  lastAttemptAt?: number;
  ackedAt?: number;
  failedReason?: string;
  status: DurableParentWakeStatus;
  metadata?: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
};

export type DurableSideEffectUncertaintyFact = {
  factId: string;
  kind: DurableSideEffectUncertaintyKind;
  sourceRunId?: string;
  stepId?: string;
  eventId?: string;
  refId?: string;
  factsRef?: string;
  dedupeKey?: string;
  facts?: Record<string, unknown>;
  status: DurableSideEffectUncertaintyStatus;
  resolutionKind?: string;
  resolutionRef?: string;
  resolvedAt?: number;
  metadata?: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
};

export type DurableContinuationCleanupAudit = {
  cleanupId: string;
  targetKind: DurableContinuationCleanupTargetKind;
  targetId: string;
  runtimeRunId?: string;
  stepId?: string;
  supersededByRef?: string;
  reason?: string;
  requestedBy?: string;
  dedupeKey: string;
  status: DurableContinuationCleanupStatus;
  metadata?: Record<string, unknown>;
  createdAt: number;
};

export type DurableDedupeLedgerEntry = {
  ledgerId: string;
  scope: DurableDedupeScope;
  dedupeKey: string;
  subjectRef?: string;
  operationKind?: string;
  status: DurableDedupeLedgerStatus;
  firstSeenAt: number;
  lastSeenAt: number;
  hitCount: number;
  metadata?: Record<string, unknown>;
};

export type DurableUnresolvedObligationKind =
  | "pending_wake"
  | "unresolved_uncertainty"
  | "open_child"
  | "expired_run_claim"
  | "expired_step_claim"
  | "pending_result_mailbox";

export type DurableUnresolvedObligation = {
  obligationId: string;
  kind: DurableUnresolvedObligationKind;
  runtimeRunId?: string;
  stepId?: string;
  wakeId?: string;
  uncertaintyFactId?: string;
  subjectRef?: string;
  reason?: string;
  status: string;
  createdAt: number;
  updatedAt: number;
  metadata?: Record<string, unknown>;
};

export type CreateDurableRuntimeRunInput = {
  runtimeRunId?: string;
  operationKind: string;
  operationVersion?: string;
  status?: DurableRuntimeRunStatus;
  recoveryState?: DurableRecoveryState;
  idempotencyKey?: string;
  requestHash?: string;
  sourceType?: string;
  sourceRef?: string;
  inputRef?: string;
  checkpointRef?: string;
  parentRuntimeRunId?: string;
  parentStepId?: string;
  messageId?: string;
  turnId?: string;
  workUnitId?: string;
  reportRouteId?: string;
  completedAt?: number;
  metadata?: Record<string, unknown>;
  now?: number;
};

export type AppendDurableRuntimeEventInput = {
  runtimeRunId: string;
  eventId?: string;
  eventType: string;
  eventTime?: number;
  stepId?: string;
  agentInvocationId?: string;
  toolInvocationId?: string;
  idempotencyKey?: string;
  payload?: Record<string, unknown>;
  payloadHash?: string;
  checkpointRef?: string;
  causationEventId?: string;
  correlationId?: string;
};

export type UpdateDurableRuntimeRunInput = {
  runtimeRunId: string;
  status?: DurableRuntimeRunStatus;
  recoveryState?: DurableRecoveryState;
  completedAt?: number | null;
  checkpointRef?: string | null;
  workUnitId?: string | null;
  reportRouteId?: string | null;
  claimedBy?: string | null;
  claimExpiresAt?: number | null;
  heartbeatAt?: number | null;
  metadata?: Record<string, unknown>;
  now?: number;
};

export type CreateDurableRuntimeStepInput = {
  runtimeRunId: string;
  stepId?: string;
  parentStepId?: string;
  stepType: DurableRuntimeStepType;
  status?: DurableRuntimeStepStatus;
  recoveryState?: DurableRecoveryState;
  attempt?: number;
  maxAttempts?: number;
  idempotencyKey?: string;
  inputRef?: string;
  outputRef?: string;
  errorRef?: string;
  checkpointRef?: string;
  metadata?: Record<string, unknown>;
  now?: number;
};

export type UpdateDurableRuntimeStepInput = {
  runtimeRunId: string;
  stepId: string;
  expectedClaimedBy?: string;
  status?: DurableRuntimeStepStatus;
  recoveryState?: DurableRecoveryState;
  attempt?: number;
  maxAttempts?: number | null;
  inputRef?: string | null;
  outputRef?: string | null;
  errorRef?: string | null;
  checkpointRef?: string | null;
  claimedBy?: string | null;
  claimExpiresAt?: number | null;
  heartbeatAt?: number | null;
  startedAt?: number | null;
  completedAt?: number | null;
  metadata?: Record<string, unknown>;
  now?: number;
};

export type CreateDurableRuntimeRefInput = {
  refId?: string;
  runtimeRunId: string;
  stepId?: string;
  refKind: DurableRuntimeRefKind;
  mediaType?: string;
  hash?: string;
  storageKind?: "inline" | "file" | "external";
  storageUri?: string;
  metadata?: Record<string, unknown>;
  now?: number;
};

export type CreateDurableRuntimeLinkInput = {
  parentRuntimeRunId: string;
  parentStepId: string;
  childRuntimeRunId: string;
  linkType: DurableRuntimeLinkType;
  status?: DurableRuntimeLinkStatus;
  metadata?: Record<string, unknown>;
  now?: number;
};

export type UpdateDurableRuntimeLinkInput = {
  parentRuntimeRunId: string;
  parentStepId: string;
  childRuntimeRunId: string;
  status?: DurableRuntimeLinkStatus;
  metadata?: Record<string, unknown>;
  now?: number;
};

export type CreateDurableRuntimeTimerInput = {
  timerId?: string;
  runtimeRunId: string;
  stepId?: string;
  timerType: DurableRuntimeTimer["timerType"];
  dueAt: number;
  metadata?: Record<string, unknown>;
  now?: number;
};

export type UpdateDurableRuntimeTimerInput = {
  timerId: string;
  status: DurableRuntimeTimerStatus;
  firedAt?: number | null;
  cancelledAt?: number | null;
  now?: number;
};

export type CreateDurableRuntimeSignalInput = {
  signalId?: string;
  runtimeRunId: string;
  stepId?: string;
  signalType: DurableRuntimeSignal["signalType"];
  idempotencyKey?: string;
  payloadRef?: string;
  correlationId?: string;
  metadata?: Record<string, unknown>;
  now?: number;
};

export type CreateDurableParentWakeInput = {
  wakeId?: string;
  parentRunId?: string;
  parentSessionKey?: string;
  targetAgent?: string;
  targetSession?: string;
  targetChannel?: string;
  reason: DurableParentWakeReason;
  factsRef?: string;
  sourceRunId?: string;
  dedupeKey: string;
  metadata?: Record<string, unknown>;
  now?: number;
};

export type UpdateDurableParentWakeInput = {
  wakeId: string;
  status: DurableParentWakeStatus;
  attemptCount?: number;
  lastAttemptAt?: number | null;
  ackedAt?: number | null;
  failedReason?: string | null;
  metadata?: Record<string, unknown>;
  now?: number;
};

export type CreateDurableSideEffectUncertaintyFactInput = {
  factId?: string;
  kind: DurableSideEffectUncertaintyKind;
  sourceRunId?: string;
  stepId?: string;
  eventId?: string;
  refId?: string;
  factsRef?: string;
  dedupeKey?: string;
  facts?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  now?: number;
};

export type ResolveDurableSideEffectUncertaintyFactInput = {
  factId: string;
  status: Extract<DurableSideEffectUncertaintyStatus, "resolved" | "superseded">;
  resolutionKind?: string;
  resolutionRef?: string;
  metadata?: Record<string, unknown>;
  now?: number;
};

export type RecordDurableContinuationCleanupInput = {
  cleanupId?: string;
  targetKind: DurableContinuationCleanupTargetKind;
  targetId: string;
  runtimeRunId?: string;
  stepId?: string;
  supersededByRef?: string;
  reason?: string;
  requestedBy?: string;
  dedupeKey: string;
  status?: DurableContinuationCleanupStatus;
  metadata?: Record<string, unknown>;
  now?: number;
};

export type RecordDurableDedupeLedgerInput = {
  ledgerId?: string;
  scope: DurableDedupeScope;
  dedupeKey: string;
  subjectRef?: string;
  operationKind?: string;
  status?: DurableDedupeLedgerStatus;
  metadata?: Record<string, unknown>;
  now?: number;
};

export type ClaimDurableRuntimeRunInput = {
  operationKind?: string;
  workerId: string;
  claimTtlMs: number;
  now?: number;
};

export type ClaimDurableRuntimeStepInput = {
  operationKind?: string;
  stepType?: DurableRuntimeStepType;
  workerId: string;
  claimTtlMs: number;
  now?: number;
};

export type DurableRuntimeStoreStats = {
  path: string;
  schemaVersion: number;
  runs: number;
  events: number;
  steps: number;
  openRuns: number;
  pendingWakes: number;
  unresolvedUncertaintyFacts: number;
};

export type DurableRuntimeTimelineOptions = {
  limit?: number;
  afterEventSeq?: number;
};

export type CompactDurableRuntimeRunInput = {
  runtimeRunId: string;
  keepLastEvents?: number;
  now?: number;
};

export type CompactDurableRuntimeRunResult = {
  runtimeRunId: string;
  compacted: boolean;
  removedEvents: number;
};

export type DurableRuntimeStore = {
  createRun(input: CreateDurableRuntimeRunInput): DurableRuntimeRun;
  getRun(runtimeRunId: string): DurableRuntimeRun | undefined;
  updateRun(input: UpdateDurableRuntimeRunInput): DurableRuntimeRun | undefined;
  appendEvent(input: AppendDurableRuntimeEventInput): DurableRuntimeEvent;
  listRuns(options?: { limit?: number }): DurableRuntimeRun[];
  listOpenRuns(options?: { operationKind?: string; limit?: number }): DurableRuntimeRun[];
  claimNextRunnableRun(input: ClaimDurableRuntimeRunInput): DurableRuntimeRun | undefined;
  releaseRunClaim(input: {
    runtimeRunId: string;
    workerId: string;
    now?: number;
  }): DurableRuntimeRun | undefined;
  createStep(input: CreateDurableRuntimeStepInput): DurableRuntimeStep;
  updateStep(input: UpdateDurableRuntimeStepInput): DurableRuntimeStep | undefined;
  claimNextRunnableStep(input: ClaimDurableRuntimeStepInput): DurableRuntimeStep | undefined;
  releaseStepClaim(input: {
    runtimeRunId: string;
    stepId: string;
    workerId: string;
    now?: number;
  }): DurableRuntimeStep | undefined;
  listSteps(runtimeRunId: string): DurableRuntimeStep[];
  createRef(input: CreateDurableRuntimeRefInput): DurableRuntimeRef;
  getRef(refId: string): DurableRuntimeRef | undefined;
  listRefs(runtimeRunId: string): DurableRuntimeRef[];
  createLink(input: CreateDurableRuntimeLinkInput): DurableRuntimeLink;
  updateLink(input: UpdateDurableRuntimeLinkInput): DurableRuntimeLink | undefined;
  listChildLinks(parentRuntimeRunId: string): DurableRuntimeLink[];
  listParentLinks(childRuntimeRunId: string): DurableRuntimeLink[];
  createTimer(input: CreateDurableRuntimeTimerInput): DurableRuntimeTimer;
  updateTimer(input: UpdateDurableRuntimeTimerInput): DurableRuntimeTimer | undefined;
  listTimers(runtimeRunId?: string): DurableRuntimeTimer[];
  listDueTimers(now: number, options?: { limit?: number }): DurableRuntimeTimer[];
  createSignal(input: CreateDurableRuntimeSignalInput): DurableRuntimeSignal;
  consumeSignal(input: { signalId: string; now?: number }): DurableRuntimeSignal | undefined;
  listPendingSignals(options?: { limit?: number }): DurableRuntimeSignal[];
  listSignals(runtimeRunId: string): DurableRuntimeSignal[];
  createParentWake(input: CreateDurableParentWakeInput): DurableParentWake;
  updateParentWake(input: UpdateDurableParentWakeInput): DurableParentWake | undefined;
  getParentWake(wakeId: string): DurableParentWake | undefined;
  listParentWakes(options?: {
    parentRunId?: string;
    parentSessionKey?: string;
    status?: DurableParentWakeStatus;
    limit?: number;
  }): DurableParentWake[];
  recordSideEffectUncertaintyFact(
    input: CreateDurableSideEffectUncertaintyFactInput,
  ): DurableSideEffectUncertaintyFact;
  resolveSideEffectUncertaintyFact(
    input: ResolveDurableSideEffectUncertaintyFactInput,
  ): DurableSideEffectUncertaintyFact | undefined;
  listSideEffectUncertaintyFacts(options?: {
    sourceRunId?: string;
    status?: DurableSideEffectUncertaintyStatus;
    limit?: number;
  }): DurableSideEffectUncertaintyFact[];
  recordContinuationCleanup(
    input: RecordDurableContinuationCleanupInput,
  ): DurableContinuationCleanupAudit;
  listContinuationCleanupAudit(options?: {
    runtimeRunId?: string;
    targetKind?: DurableContinuationCleanupTargetKind;
    limit?: number;
  }): DurableContinuationCleanupAudit[];
  recordDedupeLedgerEntry(input: RecordDurableDedupeLedgerInput): DurableDedupeLedgerEntry;
  listDedupeLedgerEntries(options?: {
    scope?: DurableDedupeScope;
    status?: DurableDedupeLedgerStatus;
    limit?: number;
  }): DurableDedupeLedgerEntry[];
  listUnresolvedObligations(options?: {
    now?: number;
    limit?: number;
  }): DurableUnresolvedObligation[];
  getTimeline(runtimeRunId: string, options?: DurableRuntimeTimelineOptions): DurableRuntimeEvent[];
  compactTerminalRun(input: CompactDurableRuntimeRunInput): CompactDurableRuntimeRunResult;
  getStats(): DurableRuntimeStoreStats;
  close(): void;
};
