import type { SessionAdmissionDatabaseClaim } from "../../config/sessions/session-accessor.sqlite-entry-admission.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { GatewayContextResolver } from "../../gateway/server-methods/types.js";
import type {
  ReplyOperation,
  ReplyTurnKind,
  SessionControllerMailboxClaim,
} from "../../sessions/session-controller.contracts.js";
import type { SessionEffectRef } from "../../sessions/session-controller.lifecycle.js";
import type { AgentDatabaseRequestExecutionSource } from "../../state/openclaw-agent-execution-admission-contract.js";
import type { ReplyPayload } from "../types.js";
import type { InternalFollowupRun } from "./queue/types.js";
import type { createReplyTurnRotationEvidence } from "./reply-turn-rotation.js";

type FollowupSessionOwner = {
  current: () => SessionEntry | undefined;
  publish(entry: SessionEntry | undefined): void;
} & ({ kind: "detached" } | { kind: "session"; key: string; storePath?: string });

export type AdmittedFollowupTurn = {
  readonly runId: string;
  queued: InternalFollowupRun;
  operation: ReplyOperation;
  config: OpenClawConfig;
  session: FollowupSessionOwner;
  sessionStore?: Record<string, SessionEntry>;
  sendPolicy: "allow" | "deny";
  preflightCompactionApplied: boolean;
  /** Deferred while observing; the execution gate must prepare an approved reply. */
  prepareForExecution?: () => Promise<void>;
  memoryFlushAttempted?: boolean;
  preflightFailurePayload?: ReplyPayload;
  preflightError?: Error;
  releaseSourceAdmission?: () => Promise<void>;
};

export type UnexecutedReplyTurnCompletion =
  | { kind: "observed" }
  | { kind: "failed"; error: unknown };

export type ReplyTurnAdmission =
  | {
      status: "owned";
      operation: ReplyOperation;
      sessionEntry?: SessionEntry;
      databaseClaim?: SessionAdmissionDatabaseClaim;
    }
  | {
      status: "skipped";
      reason: "active-run" | "aborted" | "lifecycle-invalidated";
      error?: unknown;
      activeOperation?: ReplyOperation;
      sessionEntry?: SessionEntry;
      lifecycleAdmission?: SessionEffectRef;
    };

export type ReplyTurnAdmissionParams = {
  mailboxClaim?: SessionControllerMailboxClaim;
  rotationEvidence?: ReturnType<typeof createReplyTurnRotationEvidence>;
  runId?: string;
  assertRequestCurrent?: () => void;
  onDatabaseRegistration?: AgentDatabaseRequestExecutionSource["onRegistryChange"];
  /** Capture caller-owned selection during admission checks, including the writer-ordered recheck. */
  captureRunSelection?: () => void;
  providerReviewAcknowledgment?: import("../../sessions/provider-review.js").ProviderReviewAcknowledgment;
  agentId?: string;
  sessionKey: string;
  sessionId: string;
  expectedSessionId?: string;
  /** Preserve a refused pre-execution admission’s physical owner during source reselection. */
  expectedDatabaseIncarnation?: string;
  /** Observed predecessors, from oldest to newest. */
  expectedActiveOperations?: readonly ReplyOperation[];
  storePath?: string;
  kind: ReplyTurnKind;
  resetTriggered: boolean;
  routeThreadId?: string | number;
  originatingLeafEntryId?: string | null;
  /**
   * Move this already-held operation into sessionKey's run slot instead of
   * creating a new one. Used when a native command turn (admitted under its
   * slash source key) continues into a full agent turn on the target session.
   */
  adoptOperation?: ReplyOperation;
  upstreamAbortSignal?: AbortSignal;
  resolveGatewayContext?: GatewayContextResolver;
  waitTimeoutMs?: number;
  waitForActive?: boolean;
  retainLifecycleAdmissionOnActive?: boolean;
  onLifecycleInterrupt?: () => void;
};
