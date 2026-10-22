import type { SessionPermissionMode } from "../../packages/gateway-protocol/src/schema/sessions-row.js";
import type { OperationalRunInstanceRef } from "../agents/admitted-run-context.js";
import type { MessagingToolSend } from "../agents/embedded-agent-messaging.types.js";
import type { ReplyCompletion, ReplyExpectation } from "../agents/reply-completion.types.js";
import type { RequesterOrigin } from "../agents/requester-origin.js";
import type { resolveAgentTurnExecutionStatus } from "../auto-reply/reply/agent-runner-execution-status.js";
import type { FollowupQueueDisposition } from "../auto-reply/reply/queue-policy.js";
import type { FollowupRunPayload } from "../auto-reply/reply/queue/followup-run-payload.types.js";
import type { QueueSettings } from "../auto-reply/reply/queue/queue-settings.types.js";
import type { ReplyDispatchDeliveryOutcome } from "../auto-reply/reply/reply-dispatch-outcome.types.js";
import type { ReplyFollowupAdmissionBarrierTimeoutPolicy } from "../auto-reply/reply/reply-dispatcher.types.js";
import type { ReplyOperationStaleReason } from "../auto-reply/reply/reply-run-finalization-lease.js";
import type { SessionEntryTargetPatchScope } from "../config/sessions/session-accessor.types.js";
import type { SessionActor } from "../config/sessions/session-actor-contract.js";
import type { SessionAdmissionDatabaseClaim } from "../config/sessions/session-admission-claim.types.js";
import type { SessionAdmissionTransition } from "../config/sessions/session-admission-transition.types.js";
import type { SessionEntryCohortReader } from "../config/sessions/session-entry-read-runtime.types.js";
import type { InternalSessionEntry } from "../config/sessions/types.js";
import type { AgentRunDelegatedAuthority } from "../infra/agent-run-authority.types.js";
import type { DiagnosticEmbeddedRunOwner } from "../infra/diagnostic-model-request-provenance.js";
import type { Deferred, createDeferredCore } from "../shared/deferred.js";
import type { ReplyPayload } from "../shared/reply-payload.types.js";
import type { OpenClawAgentDatabaseIdentity } from "../state/openclaw-agent-db-identity.js";
import type { DeliveryContext } from "../utils/delivery-context.types.js";
import type {
  ReplyOperationState,
  ReplyOperationActivePhase,
  ReplyOperationResult as ControllerReplyOperationResult,
} from "./reply-operation-state.js";
import type { AgentWorkAdmissionIdentity } from "./session-agent-work-admission.js";
import type {
  ReplyBackendQueueMessageOptions,
  ReplyMessageInjectionResolution,
  ReplyMessageInjectionRejectionReason,
  ReplyToolAuthorityRoute,
  ReplyToolAuthorityOverlay,
  ReplyToolAuthorityRequester,
  ReplyToolAuthoritySnapshot,
  ReplyTurnParticipants,
  ReplyBackendQueueMessageResult,
  ReplyBackendMessageInjection,
  ReplyToolAuthorityPreparation,
  ReplyBackendMessageInjectionV2,
  ReplyBackendHandle,
  ReplyTurnParticipantInput,
} from "./session-controller.backend-contracts.js";
import type { LifecycleDiagnosticOperation } from "./session-controller.lifecycle-diagnostics.js";
import type { SessionTarget } from "./session-controller.target.js";
import type {
  SessionControllerWatchdogAttempt,
  SessionControllerWatchdog,
} from "./session-controller.watchdog.js";

export type {
  ReplyBackendCancelReason,
  ReplyMessageInjectionResolution,
  ReplyMessageInjectionRejectionReason,
  ReplyBackendQueueMessageMismatch,
  ReplyBackendQueueMessageOptions,
  ReplyMessageInjectionOptions,
  ReplyToolAuthorityRoute,
  ReplyToolAuthorityOverlay,
  ReplyToolAuthorityRequester,
  ReplyToolAuthoritySnapshot,
  ReplyTurnParticipant,
  ReplyTurnParticipants,
  ReplyBackendQueueMessageResult,
  ReplyBackendMessageInjection,
  ReplyToolAuthorityPreparation,
  ReplyBackendMessageInjectionV2,
  ReplyBackendHandle,
} from "./session-controller.backend-contracts.js";

export type ReplyOperationPhase = ReplyOperationActivePhase | "completed" | "failed" | "aborted";
type ReplyOperationResult = Exclude<ControllerReplyOperationResult, { kind: "yielded" }>;

export type ReplyTurnKind = "visible" | "heartbeat" | "queued_followup";

/** An adapter over one existing execution owner; it never acquires another run slot. */
type ReplyMessageInjectionOwner = {
  readonly backendIdentity: object;
  readonly toolAuthorityFingerprint?: string;
  readonly requesterPrincipalKey?: string;
  /** One concrete attachment lifetime; reusing a backend handle cannot revive its receipts. */
  readonly admissionIdentity: object;
  acceptParticipant?(participant: ReplyTurnParticipantInput): void;
  projectToolAuthorityFingerprint(overlay: ReplyToolAuthorityOverlay): string | undefined;
  projectToolAuthorityFingerprintAsync: (
    overlay: ReplyToolAuthorityOverlay,
  ) => Promise<string | undefined>;
  projectRequesterToolAuthorityFingerprint(
    requester: ReplyToolAuthorityRequester,
  ): string | undefined;
  projectRequesterToolAuthorityFingerprintAsync(
    requester: ReplyToolAuthorityRequester,
  ): Promise<string | undefined>;
  resolve(params: {
    requesterToolAuthority?: ReplyToolAuthorityRequester;
    preparation?: ReplyToolAuthorityPreparation;
    options?: ReplyBackendQueueMessageOptions;
    personalToolParticipant?: ReplyTurnParticipantInput;
    inboundAudio?: boolean;
    allowPendingUserInputAnswer?: false;
    assertCurrent?: () => void;
  }): ReplyMessageInjectionResolution;
  recordAccepted(options?: { inboundAudio?: boolean }): void;
  abort(): boolean;
};

export const replyMessageInjectionTargetOwner = Symbol.for(
  "openclaw.sessionController.messageInjectionTargetOwner",
);
export type ReplyMessageInjectionTarget = {
  readonly [replyMessageInjectionTargetOwner]: ReplyMessageInjectionOwner;
  readonly runId?: string;
  /** Original source input retained by the captured execution owner. */
  readonly sourceTurnId?: string;
};

export const replyRunInterruptTargetOperation = Symbol.for(
  "openclaw.sessionController.interruptTargetOperation",
);
export type ReplyRunInterruptTarget = {
  readonly [replyRunInterruptTargetOperation]: ReplyOperation;
};

export type ReplyMessageInjectionOutcome =
  | { status: "indeterminate"; errorMessage: string }
  | { status: "accepted" }
  /** Terminal authority failure; the separately recorded acceptance stays unchanged. */
  | { status: "failed"; error: Error }
  | { status: "rejected"; reason: ReplyMessageInjectionRejectionReason; errorMessage?: string };

export type ReplyMessageInjectionAttempt = {
  /** Native run identity captured with the opaque execution owner. */
  targetRunId: string | undefined;
  /** Settles once the runtime accepts or rejects ownership of this exact message. */
  acceptance: Promise<boolean>;
  /** Settles after the backend confirms or rejects this exact injection. */
  outcome: Promise<ReplyMessageInjectionOutcome>;
};

export type ReplyOperation = {
  readonly watchdog: SessionControllerWatchdog;
  readonly personalToolParticipants?: ReplyTurnParticipants;
  readonly key: string;
  readonly sessionId: string;
  /** Captured logical owner for session activity, including raw global keys. */
  readonly agentId?: string;
  readonly turnKind: ReplyTurnKind;
  /** Gateway lifecycle that admitted this process-local owner. */
  readonly lifecycleGeneration?: string;
  readonly routeThreadId?: string | number;
  /** Transcript branch leaf from which this operation was admitted. */
  readonly originatingLeafEntryId?: string | null;
  readonly abortSignal: AbortSignal;
  readonly resetTriggered: boolean;
  /**
   * True when this operation was admitted to recover a terminal session (a
   * leftover failed/timeout/killed run). Concurrent visible turns reading the
   * same terminal store snapshot must NOT force-clear such an operation: it is a
   * sibling recovery already in flight, not the proven stale leftover.
   */
  readonly terminalRecovery: boolean;
  /**
   * Sticky fact for audio accepted into this operation after its originating turn.
   * Final delivery reads it because the original dispatch context cannot change.
   */
  readonly acceptedSteeredInboundAudio: boolean;
  /** Sticky fact: a final message-tool send already answered this turn's source. */
  readonly sourceReplyDelivered: boolean;
  /** Immutable tool authority accepted by the active backend for steered user turns. */
  readonly toolAuthorityFingerprint?: string;
  readonly requesterPrincipalKey?: string;
  /** Initial selected model; a concrete attempt must not replace user intent. */
  readonly requestedToolAuthorityRoute?: ReplyToolAuthorityRoute;
  /** Current candidate proven automatic by the fallback owner; identity marks its attempt. */
  readonly automaticFallbackRoute?: ReplyToolAuthorityRoute;
  /** Concrete provider/model route currently selected for this operation. */
  readonly toolAuthorityRoute?: ReplyToolAuthorityRoute;
  readonly phase: ReplyOperationPhase;
  readonly result: ReplyOperationResult | null;
  /** Its fenced admission ended; raw producer settlement remains independently retained. */
  readonly admissionRetired: boolean;
  /** Retire only after exact writer fences and execution authority permit a successor. */
  retireAdmissionAfterFencing(): Promise<boolean>;
  /** Frozen backend outcome; cancellation and lane settlement remain separate. */
  readonly abortFrozen: boolean;
  /** Retire exact placement authority on cleanup; never a raw writer-settlement receipt. */
  registerExecutionCleanup(cleanup: () => Promise<void>): () => void;
  /** Retain this producer until an admitted nested native body actually returns. */
  retainExecution(): () => void;
  /** Fence one exact persisted writer before terminal cleanup may release the run slot. */
  registerTerminalProducerFence(fence: () => Promise<boolean>): () => void;
  /** True after cleanup could not prove every unsettled producer durably fenced. */
  readonly terminalProducerBlocked: boolean;
  /** Set when a stale-watchdog expiry forced this operation's run_stalled result. */
  readonly staleExpiryReason?: ReplyOperationStaleReason;
  readonly startedAtMs: number;
  readonly lastActivityAtMs: number;
  /** True when this operation has owned the supplied session ID. */
  hasOwnedSessionId(sessionId: string): boolean;
  /** Capture lineage before a pending barrier outlives this operation's lane. */
  captureOwnedSessionIds(): Set<string>;
  recordActivity(): void;
  setPhase(next: ReplyOperationActivePhase): void;
  /** Mark this operation as waiting on prior same-session maintenance. */
  markWaitingForDeferredMaintenance(): void;
  /** Return a maintenance-waiting operation to queued if the run has not started. */
  markDeferredMaintenanceWaitEnded(): void;
  markWaitingForGlobalLane(): void;
  /** Return a global-lane-waiting operation to queued once capacity is granted. */
  markGlobalLaneWaitEnded(): void;
  markTerminalRecovery(): void;
  /** A steered input joined this operation; any earlier source answer predates it. */
  markSteeredInputAccepted(params: { inboundAudio: boolean }): void;
  markSourceReplyDelivered(): void;
  /** Freeze the complete caller policy before a concrete backend attempt attaches. */
  /** @deprecated Use bindToolAuthoritySnapshotAsync. Supported through 2026-12-31. Removal in the first January 2027 stable release. */
  bindToolAuthoritySnapshot(snapshot: ReplyToolAuthoritySnapshot): void;
  bindToolAuthoritySnapshotAsync(snapshot: ReplyToolAuthoritySnapshot): Promise<void>;
  setAutomaticFallbackRoute(route: ReplyToolAuthorityRoute | undefined): void;
  /** Project an inbound turn through the current concrete route; settled owners fail closed. */
  /** @deprecated Use projectToolAuthorityFingerprintAsync. Supported through 2026-12-31. Removal in the first January 2027 stable release. */
  projectToolAuthorityFingerprint(overlay: ReplyToolAuthorityOverlay): string | undefined;
  projectToolAuthorityFingerprintAsync(
    this: void,
    overlay: ReplyToolAuthorityOverlay,
  ): Promise<string | undefined>;
  /** Legacy snapshots without fresh-requester projection cannot admit delegated steering. */
  projectRequesterToolAuthorityFingerprint?(
    requester: ReplyToolAuthorityRequester,
  ): string | undefined;
  projectRequesterToolAuthorityFingerprintAsync?(
    this: void,
    requester: ReplyToolAuthorityRequester,
  ): Promise<string | undefined>;
  /** Prepare fingerprint and projection together for the final concrete attempt route. */
  /** @deprecated Use bindToolAuthorityRouteAsync. Supported through 2026-12-31. Removal in the first January 2027 stable release. */
  bindToolAuthorityRoute(route: ReplyToolAuthorityRoute): string;
  bindToolAuthorityRouteAsync(route: ReplyToolAuthorityRoute): Promise<string>;
  updateSessionId(nextSessionId: string): void;
  /**
   * Native commands transfer their queued source reservation to the target session.
   * An occupied target throws ReplyRunAlreadyActiveError; unchanged keys still adopt agentId.
   */
  updateSessionKey(
    nextSessionKey: string,
    agentId?: string,
    mailboxClaim?: SessionControllerMailboxClaim,
  ): void;
  attachBackend(handle: ReplyBackendHandle): void;
  detachBackend(handle: ReplyBackendHandle): void;
  /** Reject later aborts after the backend has committed its terminal outcome. */
  freezeAbort(): void;
  /** Published SDK opt-in; controller failures already retain custody until complete(). */
  retainFailureUntilComplete(): void;
  /**
   * Records the backend's own yield and closes injection and tool authority; settlement then
   * records `yielded` unless a Stop or failure supersedes it first. False once the turn has ended.
   */
  yield(): boolean;
  /** Settles after the lifecycle owner's final delivery/persistence barrier. */
  readonly ownerSettlement: Promise<void>;
  complete(): void;
  /**
   * Complete the operation, clear active-run state, then run follow-up work.
   * Use when the follow-up can create another operation for this session.
   */
  completeThen(afterClear: () => void): void;
  /**
   * Clear active-run state immediately, but delay registered after-clear work
   * until delivery or another external barrier settles.
   */
  completeWithAfterClearBarrier(
    barrier: PromiseLike<unknown>,
    timeout?: number | ReplyFollowupAdmissionBarrierTimeoutPolicy,
  ): void;
  fail(
    code: Exclude<Extract<ReplyOperationResult, { kind: "failed" }>["code"], "aborted_by_user">,
    cause?: unknown,
  ): void;
  abort(reason?: unknown): boolean;
  abortByUser(): boolean;
  abortForRestart(): boolean;
  /** Watchdog-only terminal attribution; committed outcomes require cleanup, not Stop. */
  abortForStall(): boolean;
  supersede(beforeSupersede?: () => void): boolean;
};

export const REPLY_RUN_IDLE_SETTLE_TIMEOUT_MS = 15_000;

export class ReplyRunAlreadyActiveError extends Error {
  constructor(sessionKey: string) {
    super(`Reply run already active for ${sessionKey}`);
    this.name = "ReplyRunAlreadyActiveError";
  }
}

export class ReplyRunFollowupAdmissionBlockedError extends Error {
  constructor(sessionKey: string) {
    super(`Reply follow-up admission is blocked for ${sessionKey}`);
    this.name = "ReplyRunFollowupAdmissionBlockedError";
  }
}

export class ReplyRunSuccessorAdmissionBlockedError extends Error {
  constructor(sessionKey: string) {
    super(`Reply successor admission is blocked for ${sessionKey}`);
    this.name = "ReplyRunSuccessorAdmissionBlockedError";
  }
}

export const sessionControllerOperationState = Symbol.for(
  "openclaw.sessionController.operationState",
);
export type SessionControllerTurnKind = ReplyTurnKind | "direct";

/** Internal observations read the same operation state as the published getters. */
export type SessionControllerOperation = ReplyOperation & {
  readonly [sessionControllerOperationState]: {
    readonly phase: ReplyOperationState["phase"];
    readonly turnKind: SessionControllerTurnKind;
    retireAdmissionAfterFencing(isCurrent: () => boolean): Promise<boolean>;
    forceCleanup(isCurrent: () => boolean, cleanup?: () => Promise<void>): Promise<boolean>;
    registerTerminalProducerFence(
      fence: (isCurrent: () => boolean, options?: { persistTerminal?: true }) => Promise<boolean>,
    ): () => void;
    bindAttemptToolAuthoritySnapshot(snapshot: ReplyToolAuthoritySnapshot): Promise<() => void>;
  };
};

export type ReplyRunWaiter = {
  finish: (ended: boolean) => void;
  timer?: NodeJS.Timeout;
};

export type ReplyRunAdmissionSource = {
  sessionId: string;
  sessionIds: Set<string>;
  operation: ReplyOperation;
  databaseIdentity?: OpenClawAgentDatabaseIdentity;
};

export type ReplyRunCompletionObservation = {
  changed: boolean;
  sources: Map<OpenClawAgentDatabaseIdentity | undefined, ReplyRunAdmissionSource>;
};

export type ReplyRunAdmissionBarrier = {
  settled: Promise<void>;
  source: ReplyRunAdmissionSource;
  sources: Map<OpenClawAgentDatabaseIdentity | undefined, ReplyRunAdmissionSource>;
};

export type ReplyOperationAdmission = {
  lease?: SessionEffectRef;
  readonly databaseIdentity?: OpenClawAgentDatabaseIdentity;
  databaseClaim?: SessionAdmissionDatabaseClaim;
  reader?: SessionEntryCohortReader;
  resolveReader?: () => SessionEntryCohortReader | undefined;
  sessionTarget?: SessionEntryTargetPatchScope;
  resolveSessionTarget?: () => SessionEntryTargetPatchScope | undefined;
  sessionActor?: SessionActor;
  acquireSessionActor?: () => Promise<SessionActor | undefined>;
  /** Accepted input keeps its durable claim while capacity admission adopts the writer. */
  adoptInput?: (writer?: {
    runId: string;
    assertCurrent?: () => void;
  }) => Promise<InternalSessionEntry>;
  afterTransition?: (transition: SessionAdmissionTransition) => Promise<void>;
};

/** The exact run facts owned by one reply operation. Embedded attempts extend
 * this object in place and the runner's run-id index points back to that record. */
type SessionControllerRunAttachment = {
  readonly operation: ReplyOperation;
  /** Each attach call owns a fresh identity, even when it reuses a backend handle. */
  backend?: { readonly handle: ReplyBackendHandle };
  projectSessionActive?: boolean;
};

/** One retained scheduling owner per canonical key. Native attempts are subordinate
 * to active; waiters, fences and completion observations belong to this same entry.
 * Mailbox and mutation scheduling extend this entry, never a second keyed registry. */
export type SessionControllerEntry = {
  readonly id: string;
  readonly key: string;
  target?: SessionTarget;
  aliases: Set<string>;
  logicalAliases: Set<string>;
  mailbox?: SessionControllerMailbox;
  lifecycle?: SessionControllerLifecycle;
  active?: SessionControllerOperation;
  attachment?: SessionControllerRunAttachment | EmbeddedRunAttachment;
  sourceTurnId?: string;
  waiters: Set<ReplyRunWaiter>;
  followupBarrier?: ReplyRunAdmissionBarrier;
  successorBarrier?: ReplyRunAdmissionBarrier;
  observations: Set<ReplyRunCompletionObservation>;
};

export type ReplyOperationAfterClear = {
  callbacks: Set<(sessionId: string) => void>;
  barrier?: ReplyRunAdmissionBarrier;
};
export type ReplyOperationSuccessorBarrierGroup = {
  registrationKey: string;
  sources: Map<string, ReplyRunAdmissionSource>;
};

export type SessionEffectInterrupt = (reason?: Error) => { runId: string } | void;
export type SessionWorkRun = Readonly<{
  runId: string;
  sessionKey?: string;
  sessionId?: string;
  agentId?: string;
  controlUiVisible?: boolean;
}>;
export type SessionEffectRef = {
  readonly target: SessionTarget;
  readonly operation?: ReplyOperation;
  createHandoff(): string;
  isActive(): boolean;
  release: () => void;
  readonly released: Promise<void>;
  run: <T>(run: () => Promise<T>) => Promise<T>;
};
export type Effect = {
  diagnostic?: LifecycleDiagnosticOperation;
  sourceInput?: SessionControllerInput;
  agent?: AgentWorkAdmissionIdentity;
  run?: SessionWorkRun;
  owner?: symbol;
  isSettling?: () => boolean;
  getAbortReason?: () => unknown;
  ref: SessionEffectRef;
  entry: SessionControllerEntry;
  phase: "queued" | "validating" | "writer" | "acquired" | "released";
  generation: string;
  interrupt?: SessionEffectInterrupt;
  interrupted?: Error;
  cancel: AbortController;
  handoffs: Set<string>;
  validated: Deferred;
};
export type SessionMutationKind =
  | "reset"
  | "delete"
  | "compaction"
  | "read-marker"
  | "background-result";

export type Mutation = {
  diagnostic?: LifecycleDiagnosticOperation;
  entries: SessionControllerEntry[];
  targets: SessionTarget[];
  kind?: SessionMutationKind;
  phase: "queued" | "active" | "released";
  operations: Set<ReplyOperation>;
  ready: Deferred;
};
export type OwnerContext = {
  /** Exact raw producer context, including cleanup before a turn has been claimed. */
  sourceInput?: SessionControllerInput;
  claim?: SessionControllerMailboxClaim;
  operation?: ReplyOperation;
  effects: ReadonlySet<Effect>;
  mutations: ReadonlySet<Mutation>;
};
export type SessionControllerLifecycle = {
  targets: Map<SessionTarget, number>;
  operations: Set<ReplyOperation>;
  effects: Set<Effect>;
  mutations: Mutation[];
  closures: Set<{ reason: Error }>;
  changed: Deferred;
  readonly blocksTurnAdmission: boolean;
};

export type SessionControllerSourceCustody = {
  enqueued?: boolean;
  adopted?: boolean;
  adopting?: Promise<void>;
  /** Cancellation may notify abandonment before raw preparation releases source custody. */
  abandonment?: { completion?: Promise<void>; failure?: { error: unknown } };
  work?: Set<Promise<unknown>>;
  settling?: Promise<void>;
  completed?: boolean;
  cancellationRetired?: boolean;
  stopHeartbeat?: () => void;
  releaseAuthority?: () => void;
  failure?: unknown;
  disposeSource?: () => void;
  /** One in-process Gateway registration may adopt a pre-reserved source. */
  rpcAdopted?: boolean;
  /** The Gateway accepted this source into its protocol run registry. */
  rpcAccepted?: boolean;
};

export type SessionControllerInput = {
  readonly [inputCancellation]: AbortController;
  readonly abortSignal: AbortSignal;
  readonly instance: Readonly<{ id: string }>;
  sequence: number;
  readonly sourceTurnId?: string;
  protocolRunId?: string;
  policy: Readonly<QueueSettings>;
  mailbox: SessionControllerMailbox;
  readonly custody: SessionControllerSourceCustody;
  readonly settlement: ReturnType<typeof createDeferredCore<void>>;
  /** Current protocol-facing session identity before an operation owns it. */
  sourceSessionId?: string;
  /** Source admission identity survives later mailbox incarnation bindings. */
  target?: SessionTarget;
  source?: FollowupRun;
  sourceAdapter?: SessionControllerSourceAdapter;
  /** Process-local requester identity reference; never serialized or accepted over RPC. */
  readonly continuationCaller?: Readonly<{
    deliveryRoute?: DeliveryContext;
    run<T>(run: () => Promise<T>): Promise<T>;
  }>;
  phase: "preparing" | "waiting" | "injecting" | "claimed" | "consumed";
  readonly injectionOrder: {
    readonly resolved: boolean;
    settled: Promise<boolean>;
    settle(consumed: boolean): void;
  };
  injectionAttempted?: true;
  injection?: {
    predecessor: Promise<boolean>;
    settled: Promise<boolean>;
    settle(accepted: boolean): void;
    accepted?: boolean;
    admitted?: boolean;
  };
  claim?: SessionControllerMailboxClaim;
  ready?: (claim: SessionControllerMailboxClaim) => void;
  reject?: (error: unknown) => void;
  task?: (claim: SessionControllerMailboxClaim) => void;
  taskTurnKind?: SessionControllerTurnKind;
  /** The active mutation whose own body submitted this direct task. */
  mutation?: Mutation;
  withdrawalHolds: number;
  retirementRequested?: boolean;
  cancelling?: boolean;
  retirementPending?: boolean;
  payload: "unbound" | "ready" | "summary";
};

export type SessionControllerMailboxClaim = {
  readonly mailbox: SessionControllerMailbox;
  inputs: readonly SessionControllerInput[];
  sources: readonly FollowupRun[];
  readonly custody: SessionControllerSourceCustody;
  readonly summary: boolean;
  readonly settlement: ReturnType<typeof createDeferredCore<void>>;
  readonly abortController: AbortController;
  operation?: ReplyOperation;
  released: boolean;
  releaseRequested?: boolean;
  retryBeforeExecution?: boolean;
};

/** All runnable inputs, including direct native producers, share this ordered owner. */
export type SessionControllerMailbox = {
  readonly key: string;
  readonly owner: SessionControllerEntry;
  clearing?: boolean;
  nextSequence: number;
  entries: SessionControllerInput[];
  claim?: SessionControllerMailboxClaim;
  priority?: SessionControllerInput;
  preparing?: boolean;
  wake(): void;
  dispatch?: (claim: SessionControllerMailboxClaim) => Promise<void>;
  dispatchEnabled?: boolean;
  timer?: ReturnType<typeof setTimeout>;
  abortController: AbortController;
  readonly items: FollowupRun[];
  readonly draining: boolean;
  readonly inFlight: ReadonlySet<FollowupRun>;
  lastEnqueuedAt: number;
  mode: QueueSettings["mode"];
  debounceMs: number;
  cap: number;
  dropPolicy: "old" | "new" | "summarize";
  droppedCount: number;
  summaryLines: string[];
  summarySources: FollowupRun[];
  activeSummarySources: Set<FollowupRun>;
  summaryElisions: Array<{
    contextKey: string;
    count: number;
    sources: FollowupRun[];
    summaryLines: string[];
    sourceRefs: Map<FollowupRun, FollowupRun>;
  }>;
  lastRun?: FollowupRun["run"];
  recentSources: Map<string, { input: SessionControllerInput; expires: number }>;
};

export type SessionControllerSourceAdapter = {
  readonly scope?: string;
  readonly authority?: { assertCurrent(): void; signal?: AbortSignal };
  readonly signal?: AbortSignal;
  readonly requester?: Readonly<{ deviceId?: string; connectionId?: string; clientId?: string }>;
  /** Known routing identity before a physical target exists; never execution authority. */
  readonly preparation?: Readonly<{ agentId?: string }>;
  /** False for internal work that ordinary operator chat surfaces must preserve. */
  readonly controlUiVisible?: boolean;
  /** Initial presentation copied to the claimed operation; the adapter is not a runtime owner. */
  readonly projectSessionActive?: boolean;
  /** Side questions stay independent from main-turn session stops. */
  readonly turnKind?: "main" | "btw";
  cancel?(reason?: unknown): void;
  /** Joins accepted cancellation publication without joining raw source cleanup. */
  cancellationAcknowledgment?(): Promise<void>;
  onSettled?(): void | Promise<void>;
};

export type SessionControllerSourceInjection = {
  admit(): Promise<boolean>;
  accepted(accepted: boolean): void;
  finish(consumed: boolean): void;
};

export type SessionControllerWithdrawalHold = (() => void) & {
  release(): void;
  commit(reason?: unknown): boolean;
  cancel(assertCurrent: () => void, reason?: unknown): boolean;
};

export const inputCancellation = Symbol.for("openclaw.sessionControllerInputCancellation");

export type FollowupRun = FollowupRunPayload & {
  run: FollowupRunPayload["run"] & {
    /** Observe admission without transferring the runner's settlement custody. */
    onOperationAdmitted?: (operation: ReplyOperation) => void;
  };
  /** @internal Exact controller reservation; scheduling and cancellation live on it. */
  controllerInput?: SessionControllerInput;
  /** @internal Exact selected mailbox sources shared by a queued collect batch. */
  controllerClaim?: SessionControllerMailboxClaim;
  /** @internal Source execution receipts retained across queued collect batches. */
  replyOperationRunStates?: ReplyOperationRunState[];
};

type ReplyOperationAdmissionSnapshot =
  | { status: "owned" }
  | {
      status: "accepted";
      mode: "steer" | "followup";
      reason?: "requester-mismatch" | "steering-unavailable" | "explicit-followup";
    }
  | {
      status: "skipped";
      reason:
        | "active-run"
        | "aborted"
        | "lifecycle-invalidated"
        | "queue-cap"
        | "collaborative-steering-disabled"
        | "question-response-indeterminate"
        | "question-response-refused"
        | "question-response-rejected";
    };

// Rejection diagnostics carry owner-selected codes, never user-facing error text.
export type ReplyPreRunRejectionCode =
  | "model-scope-conflict"
  | "model-scope-not-authorized"
  | "model-selection-locked"
  | "model-runtime-invalid"
  | "model-selection-rejected"
  | "model-selection-conflict"
  | "session-directive-rejected";

export type ReplyOperationRunState = {
  replyCompletion?: ReplyCompletion;
  /** The source delivery owner can keep spawned completion turns private. */
  sessionEventDelivery?: false;
  heartbeat?: {
    prepareReply: (
      replyResult: ReplyPayload | ReplyPayload[] | undefined,
      runState: ReplyOperationRunState,
    ) => Promise<{
      reply?: ReplyPayload;
      settle?: (outcome: ReplyDispatchDeliveryOutcome) => Promise<void>;
    }>;
  };
  admission?: ReplyOperationAdmissionSnapshot;
  /** Latest queue-owned disposition; original acceptance still records custody. */
  followupQueueDisposition?: FollowupQueueDisposition;
  /** The Gateway accepted this question answer or rejected its values before commitment. */
  questionInputHandled?: true;
  messageInjectionAborted?: true;
  agentTurn?: ReturnType<typeof resolveAgentTurnExecutionStatus>;
  agentTurnOwner?: ReplyOperation;
  messagingToolSentTargets?: MessagingToolSend[];
  backgroundWorkStarted?: boolean;
  preRunRejection?: ReplyPreRunRejectionCode;
  /**
   * Armed by the admitted interactive run owner. Interruption recovery consumes it once;
   * true means the session lane will answer instead.
   */
  continueStalledTurn?: (guidance?: string, owner?: ReplyOperation) => boolean;
};

export const embeddedRunCleanupAttachment = Symbol("openclaw.embeddedRunCleanupAttachment");

export type EmbeddedAgentQueueHandle = {
  kind?: "embedded";
  [embeddedRunCleanupAttachment]?: ActiveEmbeddedRunAttachment;
  runId?: string;
  /** Exact process-local diagnostic lifecycle shared with this handle's model wrapper. */
  readonly diagnosticOwner?: DiagnosticEmbeddedRunOwner;
  /** Synchronously closes diagnostic authority before this handle is evicted. */
  readonly closeDiagnostics?: () => void;
  /** Core run start time used by live recovery projections. */
  startedAtMs?: number;
  /** Exact authority of the concrete provider/model attempt behind this handle. */
  toolAuthorityFingerprint?: string;
  /** Shared outer-run owner survives an intentional native-turn replacement. */
  permissionChangeOwner?: object;
  /** Fences prior tools, revokes their approvals, then acknowledges installed permissions. */
  applyPermissionMode?: (
    mode: SessionPermissionMode | null,
    revokeApprovals: () => void,
  ) => Promise<boolean>;
  /** Atomically consumes one plain-text answer for this run's pending user-input request. */
  claimPendingUserInputAnswer?: ReplyBackendHandle["claimPendingUserInputAnswer"];
  /** Cancels this run's pending user-input request before an image is queued as a later turn. */
  cancelPendingUserInput?: (resolvedBy: string) => Promise<boolean>;
  /** Exact heartbeat owner retained after its reply-operation registration clears. */
  readonly preemptByVisibleTurn?: () => boolean;
  queueMessage: (
    text: string,
    options?: EmbeddedAgentQueueMessageOptions,
  ) => Promise<void | EmbeddedAgentQueueMessageResult>;
  messageInjection?: ReplyBackendMessageInjection;
  messageInjectionV2?: ReplyBackendMessageInjectionV2;
  isStreaming: () => boolean;
  isStopped?: () => boolean;
  /** True after this handle has accepted an abort, even while cleanup retains it. */
  isAborted?: () => boolean;
  /** True only while this exact runtime owns a live wait, not unresolved host work or cleanup. */
  ownsLiveness?: () => boolean;
  /** Interrupts a current model request; its attempt still owns settlement and replay policy. */
  recoverStalledModelCall?: () => boolean;
  isAbortable?: () => boolean;
  isCompacting: () => boolean;
  supportsTranscriptCommitWait?: boolean;
  /** True only when queueMessage preserves images supplied in its options. */
  supportsQueueMessageImages?: boolean;
  /** False keeps inbound steering with the turn owner's profile; omission permits other profiles. */
  readonly supportsCrossProfileSteering?: boolean;
  cancel?: (reason?: "user_abort" | "restart" | "superseded") => void;
  abort: (reason?: "restart") => void;
  sourceReplyDeliveryMode?: ReplyBackendHandle["sourceReplyDeliveryMode"];
  terminalReplyExpectation?: ReplyExpectation;
  taskSuggestionDeliveryMode?: ReplyBackendHandle["taskSuggestionDeliveryMode"];
};

export type EmbeddedAgentQueueMessageOptions = ReplyBackendQueueMessageOptions;

export type EmbeddedAgentQueueMessageResult = ReplyBackendQueueMessageResult;

export type ActiveEmbeddedRunSnapshot = {
  transcriptLeafId: string | null;
  messages?: unknown[];
  inFlightPrompt?: string;
};

/** Host-private binding consumed before publishing one actual backend handle. */
export type EmbeddedRunToolAuthorityBinding = (registration: {
  sessionId: string;
  sessionKey?: string;
  sessionFile?: string;
  agentId?: string;
  handle: EmbeddedAgentQueueHandle;
}) => {
  source: "reply" | "attempt";
  detached?: true;
  operation?: ReplyOperation;
  sourceTurnId?: string;
  readonly requesterPrincipalKey?: string;
  acceptsRequesterOrigin: (origin: RequesterOrigin) => boolean;
  watchdogAttempt?: SessionControllerWatchdogAttempt;
  project: (overlay: ReplyToolAuthorityOverlay) => string | undefined;
  projectAsync: (overlay: ReplyToolAuthorityOverlay) => Promise<string | undefined>;
  projectRequester?: (requester: ReplyToolAuthorityRequester) => string | undefined;
  projectRequesterAsync?: (requester: ReplyToolAuthorityRequester) => Promise<string | undefined>;
  /** Registration may precede reply-backend attachment; use requires the attached owner. */
  assertRegistrationActive: () => void;
  assertActive: () => void;
  personalToolParticipants?: ReplyTurnParticipants;
};

export type EmbeddedRunRegistration = {
  handle: EmbeddedAgentQueueHandle;
  lifecycleGeneration: string;
  /** Resolves only when this exact native producer clears, including after replacement. */
  settlement: ReturnType<typeof createDeferredCore<void>>;
  /** Full generation cleanup retained after native terminal publication clears this attachment. */
  runCleanupSettlement?: Promise<void>;
  settled?: true;
  watchdogAttempt?: SessionControllerWatchdogAttempt;
  closeWatchdogWait?: () => void;
  /** Controller-owned presentation fact; retained cleanup must not reappear after context release. */
  projectSessionActive?: boolean;
  toolAuthority?: ReturnType<EmbeddedRunToolAuthorityBinding>;
  operationalRunInstance?: OperationalRunInstanceRef;
  sessionId: string;
  sessionKey?: string;
  agentId?: string;
  delegatedAuthority?: AgentRunDelegatedAuthority;
  humanInputWaits?: Set<() => boolean>;
  onHumanInputResolved?: () => void;
};

/** The controller's exact attachment for one scoped embedded attempt. */
export type EmbeddedRunAttachment = EmbeddedRunRegistration & SessionControllerRunAttachment;

/** Unhosted or explicitly detached attempts have no controller operation. */
export type DetachedEmbeddedRunAttachment = EmbeddedRunRegistration & {
  operation?: undefined;
  backend?: undefined;
};

export type ActiveEmbeddedRunAttachment = EmbeddedRunAttachment | DetachedEmbeddedRunAttachment;

export const SESSION_CONTROLLER_DRAIN_TIMEOUT_MS = 15_000;
export type SessionStopChildrenResult = Readonly<{ stopped: number; failed: number }>;

export type CapturedSessionControllerEffect = Readonly<{
  effect: Effect;
  run: SessionWorkRun | undefined;
  released: Promise<void>;
  interrupt(reason: Error): Readonly<{ interrupted: true; run?: SessionWorkRun }> | undefined;
}>;
