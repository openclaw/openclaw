// Shared durable workflow control-plane types.
export type DurableWorkflowRunStatus =
  | "received"
  | "queued"
  | "running"
  | "waiting"
  | "waiting_signal"
  | "waiting_timer"
  | "waiting_child"
  | "retry_scheduled"
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

export type DurableWorkflowStepType =
  | "agent"
  | "tool"
  | "timer"
  | "signal"
  | "child_workflow"
  | "checkpoint"
  | "fan_in";

export type DurableWorkflowStepStatus =
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

export type DurableWorkflowRefKind = "input" | "output" | "error" | "artifact";

export type DurableWorkflowLinkType =
  | "child_workflow"
  | "handoff"
  | "subagent"
  | "evidence"
  | "artifact";

export type DurableWorkflowLinkStatus =
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "lost";

export type DurableWorkflowTimerStatus = "pending" | "fired" | "cancelled";
export type DurableWorkflowSignalStatus = "pending" | "consumed";

export type DurableWorkflowRun = {
  workflowRunId: string;
  workflowId: string;
  workflowVersion: string;
  status: DurableWorkflowRunStatus;
  recoveryState: DurableRecoveryState;
  idempotencyKey?: string;
  requestHash?: string;
  sourceType?: string;
  sourceRef?: string;
  inputRef?: string;
  checkpointRef?: string;
  parentWorkflowRunId?: string;
  parentStepId?: string;
  messageId?: string;
  turnId?: string;
  claimedBy?: string;
  claimExpiresAt?: number;
  heartbeatAt?: number;
  metadata?: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
};

export type DurableWorkflowStep = {
  workflowRunId: string;
  stepId: string;
  parentStepId?: string;
  stepType: DurableWorkflowStepType;
  status: DurableWorkflowStepStatus;
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

export type DurableWorkflowRef = {
  refId: string;
  workflowRunId: string;
  stepId?: string;
  refKind: DurableWorkflowRefKind;
  mediaType?: string;
  hash?: string;
  storageKind: "inline" | "file" | "external";
  storageUri?: string;
  metadata?: Record<string, unknown>;
  createdAt: number;
};

export type DurableWorkflowLink = {
  parentWorkflowRunId: string;
  parentStepId: string;
  childWorkflowRunId: string;
  linkType: DurableWorkflowLinkType;
  status: DurableWorkflowLinkStatus;
  metadata?: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
};

export type DurableWorkflowTimer = {
  timerId: string;
  workflowRunId: string;
  stepId?: string;
  timerType: "retry" | "deadline" | "sleep" | "human_timeout" | "child_timeout" | "scheduled_start";
  dueAt: number;
  status: DurableWorkflowTimerStatus;
  metadata?: Record<string, unknown>;
  createdAt: number;
  firedAt?: number;
  cancelledAt?: number;
};

export type DurableWorkflowSignal = {
  signalId: string;
  workflowRunId: string;
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

export type DurableWorkflowEvent = {
  eventId: string;
  workflowRunId: string;
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

export type CreateDurableWorkflowRunInput = {
  workflowRunId?: string;
  workflowId: string;
  workflowVersion?: string;
  status?: DurableWorkflowRunStatus;
  recoveryState?: DurableRecoveryState;
  idempotencyKey?: string;
  requestHash?: string;
  sourceType?: string;
  sourceRef?: string;
  inputRef?: string;
  checkpointRef?: string;
  parentWorkflowRunId?: string;
  parentStepId?: string;
  messageId?: string;
  turnId?: string;
  metadata?: Record<string, unknown>;
  now?: number;
};

export type AppendDurableWorkflowEventInput = {
  workflowRunId: string;
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

export type UpdateDurableWorkflowRunInput = {
  workflowRunId: string;
  status?: DurableWorkflowRunStatus;
  recoveryState?: DurableRecoveryState;
  completedAt?: number | null;
  checkpointRef?: string | null;
  claimedBy?: string | null;
  claimExpiresAt?: number | null;
  heartbeatAt?: number | null;
  metadata?: Record<string, unknown>;
  now?: number;
};

export type CreateDurableWorkflowStepInput = {
  workflowRunId: string;
  stepId?: string;
  parentStepId?: string;
  stepType: DurableWorkflowStepType;
  status?: DurableWorkflowStepStatus;
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

export type UpdateDurableWorkflowStepInput = {
  workflowRunId: string;
  stepId: string;
  expectedClaimedBy?: string;
  status?: DurableWorkflowStepStatus;
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

export type CreateDurableWorkflowRefInput = {
  refId?: string;
  workflowRunId: string;
  stepId?: string;
  refKind: DurableWorkflowRefKind;
  mediaType?: string;
  hash?: string;
  storageKind?: "inline" | "file" | "external";
  storageUri?: string;
  metadata?: Record<string, unknown>;
  now?: number;
};

export type CreateDurableWorkflowLinkInput = {
  parentWorkflowRunId: string;
  parentStepId: string;
  childWorkflowRunId: string;
  linkType: DurableWorkflowLinkType;
  status?: DurableWorkflowLinkStatus;
  metadata?: Record<string, unknown>;
  now?: number;
};

export type UpdateDurableWorkflowLinkInput = {
  parentWorkflowRunId: string;
  parentStepId: string;
  childWorkflowRunId: string;
  status?: DurableWorkflowLinkStatus;
  metadata?: Record<string, unknown>;
  now?: number;
};

export type CreateDurableWorkflowTimerInput = {
  timerId?: string;
  workflowRunId: string;
  stepId?: string;
  timerType: DurableWorkflowTimer["timerType"];
  dueAt: number;
  metadata?: Record<string, unknown>;
  now?: number;
};

export type UpdateDurableWorkflowTimerInput = {
  timerId: string;
  status: DurableWorkflowTimerStatus;
  firedAt?: number | null;
  cancelledAt?: number | null;
  now?: number;
};

export type CreateDurableWorkflowSignalInput = {
  signalId?: string;
  workflowRunId: string;
  stepId?: string;
  signalType: DurableWorkflowSignal["signalType"];
  idempotencyKey?: string;
  payloadRef?: string;
  correlationId?: string;
  metadata?: Record<string, unknown>;
  now?: number;
};

export type ClaimDurableWorkflowRunInput = {
  workflowId?: string;
  workerId: string;
  claimTtlMs: number;
  now?: number;
};

export type ClaimDurableWorkflowStepInput = {
  workflowId?: string;
  stepType?: DurableWorkflowStepType;
  workerId: string;
  claimTtlMs: number;
  now?: number;
};

export type DurableWorkflowStoreStats = {
  path: string;
  schemaVersion: number;
  runs: number;
  events: number;
  steps: number;
  openRuns: number;
};

export type DurableWorkflowStore = {
  createRun(input: CreateDurableWorkflowRunInput): DurableWorkflowRun;
  getRun(workflowRunId: string): DurableWorkflowRun | undefined;
  updateRun(input: UpdateDurableWorkflowRunInput): DurableWorkflowRun | undefined;
  appendEvent(input: AppendDurableWorkflowEventInput): DurableWorkflowEvent;
  listRuns(options?: { limit?: number }): DurableWorkflowRun[];
  listOpenRuns(options?: { workflowId?: string; limit?: number }): DurableWorkflowRun[];
  claimNextRunnableRun(input: ClaimDurableWorkflowRunInput): DurableWorkflowRun | undefined;
  releaseRunClaim(input: {
    workflowRunId: string;
    workerId: string;
    now?: number;
  }): DurableWorkflowRun | undefined;
  createStep(input: CreateDurableWorkflowStepInput): DurableWorkflowStep;
  updateStep(input: UpdateDurableWorkflowStepInput): DurableWorkflowStep | undefined;
  claimNextRunnableStep(input: ClaimDurableWorkflowStepInput): DurableWorkflowStep | undefined;
  releaseStepClaim(input: {
    workflowRunId: string;
    stepId: string;
    workerId: string;
    now?: number;
  }): DurableWorkflowStep | undefined;
  listSteps(workflowRunId: string): DurableWorkflowStep[];
  createRef(input: CreateDurableWorkflowRefInput): DurableWorkflowRef;
  getRef(refId: string): DurableWorkflowRef | undefined;
  listRefs(workflowRunId: string): DurableWorkflowRef[];
  createLink(input: CreateDurableWorkflowLinkInput): DurableWorkflowLink;
  updateLink(input: UpdateDurableWorkflowLinkInput): DurableWorkflowLink | undefined;
  listChildLinks(parentWorkflowRunId: string): DurableWorkflowLink[];
  listParentLinks(childWorkflowRunId: string): DurableWorkflowLink[];
  createTimer(input: CreateDurableWorkflowTimerInput): DurableWorkflowTimer;
  updateTimer(input: UpdateDurableWorkflowTimerInput): DurableWorkflowTimer | undefined;
  listTimers(workflowRunId?: string): DurableWorkflowTimer[];
  listDueTimers(now: number, options?: { limit?: number }): DurableWorkflowTimer[];
  createSignal(input: CreateDurableWorkflowSignalInput): DurableWorkflowSignal;
  consumeSignal(input: { signalId: string; now?: number }): DurableWorkflowSignal | undefined;
  listPendingSignals(options?: { limit?: number }): DurableWorkflowSignal[];
  listSignals(workflowRunId: string): DurableWorkflowSignal[];
  getTimeline(workflowRunId: string): DurableWorkflowEvent[];
  getStats(): DurableWorkflowStoreStats;
  close(): void;
};
