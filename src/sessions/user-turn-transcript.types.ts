import type { AgentMessage } from "../../packages/agent-core/src/types.js";
import type { AgentRunTerminalOutcome } from "../agents/agent-run-terminal-outcome.types.js";
import type {
  SessionTranscriptTurnMutation,
  SessionTranscriptTurnMutationResult,
} from "../config/sessions/goals-operations.types.js";
import type { SessionInputLifecycleAdmission } from "../config/sessions/session-input-lifecycle.js";
import type { SessionMessageRewriteResult } from "../config/sessions/session-message-rewrite.types.js";
import type { SessionPendingInputEndCause } from "../config/sessions/session-pending-input-end-cause.types.js";
import type { PreparedSessionMentionInvitation } from "../config/sessions/session-sharing-authority.types.js";
import type { SessionSourceAssertion } from "../config/sessions/session-source-authority.js";
import type {
  SessionTranscriptTurnExpectedState,
  SessionTranscriptTurnLifecyclePatch,
} from "../config/sessions/session-transcript-turn-lifecycle.types.js";
import type {
  TranscriptEntryAnchor,
  TranscriptTurnAdmission,
} from "../config/sessions/transcript-entry-anchor.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PersistedUserTurnMessage, UserTurnInput } from "./user-turn-input.types.js";

/** Native transcript identity of one accepted input, not an authority or replacement message. */
export type NativeSteerInputIdentity = Readonly<{
  importedFrom: string;
  externalId: string;
  cliSessionId: string;
}>;

export type UserTurnTranscriptUpdateMode = "inline" | "none";

export type UserTurnMessagePersistenceParams = {
  input?: UserTurnInput;
  message?: PersistedUserTurnMessage;
  sessionId?: string;
  agentId?: string;
  sessionKey?: string;
  cwd?: string;
  config?: unknown;
  updateMode?: UserTurnTranscriptUpdateMode;
  beforeMessageWrite?: UserTurnBeforeMessageWrite;
};

type UserTurnBeforeMessageWrite = (params: {
  message: PersistedUserTurnMessage;
  agentId?: string;
  sessionKey?: string;
}) => AgentMessage | null;

export type UserTurnTranscriptTarget = {
  sessionId: string;
  expectedSessionId?: string;
  initialSessionEntry?: SessionEntry;
  sessionKey: string;
  sessionEntry: SessionEntry | undefined;
  sessionStore?: Record<string, SessionEntry>;
  storePath?: string;
  agentId: string;
  threadId?: string | number;
  cwd?: string;
  config?: OpenClawConfig;
  beforeMessageWrite?: UserTurnBeforeMessageWrite;
};

export type UserTurnTranscriptAdmissionReceipt = TranscriptTurnAdmission;

export type UserTurnOriginalInputCommit = Readonly<{
  /** Committed source bytes; collected inputs retain each original source message. */
  message: PersistedUserTurnMessage;
  anchor: TranscriptEntryAnchor;
}>;

/** Native producer facts for the current host-admitted prompt; never a message replacement. */
export type UserTurnTranscriptAnnotation = Readonly<{
  mirrorIdentity: string;
  upstreamUserText: string;
  mirrorOrigin: string;
  mirrorSourceFingerprint: string;
}>;

export type UserTurnTranscriptPersistResult = {
  sessionTurnMutationResult?: SessionTranscriptTurnMutationResult;
  /** True only when this call inserted the transcript message. */
  appended?: boolean;
  sessionFile: string;
  sessionEntry: SessionEntry | undefined;
  messageId: string;
  message: PersistedUserTurnMessage;
  admission: UserTurnTranscriptAdmissionReceipt;
};

export type UserTurnTranscriptTargetResolver =
  | UserTurnTranscriptTarget
  | (() => UserTurnTranscriptTarget | undefined | Promise<UserTurnTranscriptTarget | undefined>);

export type PersistUserTurnTranscriptParams = UserTurnTranscriptTarget & {
  prepareMentionInvitation?: (
    message: PersistedUserTurnMessage,
  ) => PreparedSessionMentionInvitation | undefined;
  beforeFreshMessageCommit?: SessionSourceAssertion;
  sessionTurnMutation?: SessionTranscriptTurnMutation;
  input?: UserTurnInput;
  message?: PersistedUserTurnMessage;
  logicalTurnId?: string;
  updateMode?: UserTurnTranscriptUpdateMode;
  expectedSessionState?: SessionTranscriptTurnExpectedState;
  sessionLifecyclePatch?: SessionTranscriptTurnLifecyclePatch;
  onOriginalInputCommitted?: (commit: UserTurnOriginalInputCommit) => void;
};

type UserTurnInputResolver = () => UserTurnInput | undefined | Promise<UserTurnInput | undefined>;

export type CreateUserTurnTranscriptRecorderParams = {
  /** The channel dispatch accepted this input before constructing its recorder. */
  inputAlreadyAccepted?: boolean;
  prepareMentionInvitation?: (
    message: PersistedUserTurnMessage,
  ) => PreparedSessionMentionInvitation | undefined;
  /** Authenticated input identity independent of prepared media paths. */
  pendingInputRequestFingerprint?: string;
  /** Durable channel source turns may reopen their own cancelled, unconsumed attempt. */
  reclaimCancelledSourceTurn?: boolean;
  trackInputCompletion?: boolean;
  /** Trusted settle replay candidates; storage must match the complete original request hash. */
  pendingInputReplaySourceSessionKeys?: readonly string[];
  /** Exact admitted source recorders consumed by this collected transcript message. */
  pendingInputSources?: readonly UserTurnTranscriptRecorder[];
  sessionTurnMutation?: SessionTranscriptTurnMutation;
  input?: UserTurnInput;
  message?: PersistedUserTurnMessage;
  resolveInput?: UserTurnInputResolver;
  target: UserTurnTranscriptTargetResolver;
  updateMode?: UserTurnTranscriptUpdateMode;
  beforeMessageWrite?: UserTurnBeforeMessageWrite;
  errorContext?: string;
  /** Revalidate the original input at fresh commit, not at ACK or preparation. */
  assertOriginalInputCommit?: SessionSourceAssertion;
  onPersistenceError?: (error: unknown) => void;
  onMessagePersisted?: (message: PersistedUserTurnMessage) => void | Promise<void>;
  /** First foreground submission, after the input and runtime-context persistence settle. */
  onInputSubmitted?: () => void | Promise<void>;
  /** Fresh original input only, after durable append and before transcript publication. */
  onOriginalInputCommitted?: (commit: UserTurnOriginalInputCommit) => void;
  expectedSessionState?: SessionTranscriptTurnExpectedState;
  sessionLifecyclePatch?: SessionTranscriptTurnLifecyclePatch;
};

type UserTurnPersistenceOptions = {
  target?: UserTurnTranscriptTargetResolver;
  sessionLifecyclePatch?: SessionTranscriptTurnLifecyclePatch;
  /** Pin admitted storage without replacing the recorder's target resolver or metadata. */
  storageTarget?: Readonly<
    Pick<UserTurnTranscriptTarget, "agentId" | "sessionKey" | "sessionId"> & { storePath: string }
  >;
  updateMode?: UserTurnTranscriptUpdateMode;
  cwd?: string;
};

export type PreparedModelPromptProjection = {
  intent: { anchor: TranscriptEntryAnchor; text: string };
  onCommitted: (result: SessionMessageRewriteResult | null) => Promise<PersistedUserTurnMessage>;
};

export type UserTurnTranscriptRecorder = {
  readonly message: PersistedUserTurnMessage | undefined;
  /** Records observed audio authorization failures against their original attachment references. */
  recordAudioApiKeyFailures?: (
    failures: readonly { reference: string; provider: string }[],
  ) => Promise<void>;
  resolveMessage: () => Promise<PersistedUserTurnMessage | undefined>;
  /** Committed or delivered input, accepted pending custody, and blocked notices are exempt. */
  assertOriginalInputCommit?: SessionSourceAssertion;
  /** Durable input custody leaves the active transcript unchanged until execution owns it. */
  stageApproved?: (options: {
    runId: string;
    recoverySource?: import("../gateway/operator-run-recovery-source.codec.js").QueuedOperatorRecoverySource;
    retryCancelled?: boolean;
    storageTarget?: UserTurnPersistenceOptions["storageTarget"];
    lifecycleAdmission?: SessionInputLifecycleAdmission;
    assertCurrent: () => void;
    assertAdmittedCurrent?: () => void;
    assertCompletionCurrent?: () => void;
    authority?: import("../config/sessions/session-pending-input-authority.js").SessionPendingInputAuthority;
  }) => Promise<boolean>;
  getProcessingCompletion?: () => AgentRunTerminalOutcome | undefined;
  /** @deprecated Await completeProcessingAsync. Final compatibility day: 2026-12-31. Removal in the first January 2027 stable release. */
  completeProcessing?: (outcome: AgentRunTerminalOutcome) => AgentRunTerminalOutcome | undefined;
  completeProcessingAsync?: (
    outcome: AgentRunTerminalOutcome,
  ) => Promise<AgentRunTerminalOutcome | undefined>;
  getPendingInputMessage?: () => PersistedUserTurnMessage | undefined;
  isPendingInputConsumed?: () => boolean;
  validateCommittedReplay?: () => Promise<void>;
  withPendingInput?: <T>(run: () => T) => T;
  withPendingInputCurrent?: <T>(run: () => T) => Promise<Awaited<T>>;
  assertPendingInputLifetimeCurrent?: () => void;
  finishPendingInput?: (
    disposition: "cancelled" | "interrupted",
    endCause: SessionPendingInputEndCause,
  ) => void;
  /** Drop process custody after consumption without inventing a terminal cause. */
  releasePendingInput?: () => void;
  /** Drop live custody on a transient outage while retaining the queued durable input. */
  relinquishPendingInput?: () => void;
  /** Join accepted completion and disposition writes before releasing the turn's admission. */
  waitForPendingInputSettlement?: () => Promise<void>;
  /** Replaces generated current-turn text before runtime persistence/provider submission. */
  replaceTextBeforePersistence?: (text: string) => void;
  /** Confirms exact-run steering provenance after transcript commitment is proven. */
  confirmSteerTargetRunIdForPersistence?: (
    targetRunId: string,
    nativeInputIdentity?: NativeSteerInputIdentity,
  ) => Promise<void>;
  getPersistedMessage?: () => PersistedUserTurnMessage | undefined;
  /** Freeze model-facing text on the canonical user record before its first provider dispatch. */
  captureModelPromptProjection?: (
    text: string,
    assertCurrent: () => void,
  ) => Promise<PersistedUserTurnMessage>;
  /** Prepare a projection for the carrier's actor commit without publishing it early. */
  prepareModelPromptProjection?: (
    text: string,
    assertCurrent: () => void,
  ) => Promise<PreparedModelPromptProjection | undefined>;
  getAdmissionReceipt: () => UserTurnTranscriptAdmissionReceipt | undefined;
  /** Persistence and `waitForRuntimePersistence` settle the handler's write and reject on its failure. */
  setAdmissionHandler?: (
    handler: (admission: UserTurnTranscriptAdmissionReceipt) => void | Promise<void>,
  ) => void;
  markSentToProvider?: () => void;
  markRuntimePersistencePending: (pending: Promise<void>) => void;
  markRuntimePersisted: (
    message?: PersistedUserTurnMessage,
    anchor?: TranscriptEntryAnchor | UserTurnTranscriptAdmissionReceipt,
    persistence?: { appended: boolean },
  ) => void;
  markBlocked: () => void;
  hasPersisted: () => boolean;
  isBlocked: () => boolean;
  hasRuntimePersistencePending: () => boolean;
  waitForRuntimePersistence: () => Promise<void>;
  persistApproved: (
    params?: UserTurnPersistenceOptions & {
      expectedSessionId?: string;
      expectedSessionState?: SessionTranscriptTurnExpectedState;
      beforeFreshMessageCommit?: SessionSourceAssertion;
      /** Allow a later explicit persistence attempt when this attempt appends nothing. */
      retryIfUnpersisted?: boolean;
    },
  ) => Promise<UserTurnTranscriptPersistResult | undefined>;
  persistBlocked: (
    message: PersistedUserTurnMessage,
    params?: UserTurnPersistenceOptions,
  ) => Promise<UserTurnTranscriptPersistResult | undefined>;
  persistFallback: (
    params?: UserTurnPersistenceOptions,
  ) => Promise<UserTurnTranscriptPersistResult | undefined>;
};
