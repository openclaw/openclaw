import type { OperationalRunInstanceRef } from "../agents/admitted-run-context.js";
import type { ChatAbortDiagnosticReason } from "../gateway/chat-abort-diagnostics.js";
import type { AgentRunDelegatedAuthority } from "../infra/agent-run-authority.types.js";
import type {
  SessionControllerInput,
  SessionControllerSourceAdapter,
} from "./session-controller.contracts.js";

type ChatTerminalProducer = {
  sessionId: string;
  sessionKey: string;
  handoff: (settle: (producerCompleted: Promise<unknown>) => Promise<void>) => boolean;
};

export type RpcSourceTiming = {
  readonly queuedAtMs: number;
  startedAtMs?: number;
  expiresAtMs: number;
  /** Process-local monotonic reading; unlike the surrounding timestamps, not an epoch. */
  readonly queueDeadlineAtMs?: number;
  readonly timeoutMs: number;
  cancelQueueDeadline: () => void;
  expireQueue: () => void;
};

export type RpcSourceAdapter = SessionControllerSourceAdapter & {
  /** Source-local deadline facts; execution owns the running timeout. */
  timing?: RpcSourceTiming;
  /** Captures this run's canonical producer before cancellation releases its live slot. */
  resolveTerminalProducer?: () => ChatTerminalProducer | undefined;
  lifecycleGeneration?: string;
  /** Exact operational instance created by this controller registration. */
  operationalRunInstance?: OperationalRunInstanceRef;
  /** Exact approval lease captured when this controller's execution was admitted. */
  agentRunDelegatedAuthority?: AgentRunDelegatedAuthority;
  providerId?: string;
  authProviderId?: string;
  abortStopReason?: string;
  /** Owner-recorded diagnostic cause; does not change terminal lifecycle semantics. */
  abortDiagnosticReason?: ChatAbortDiagnosticReason;
  /** Latest argument-free validation diagnostic for operator-initiated aborts. */
  toolErrorSummary?: string;
  /** True after the terminal session-store update has completed. */
  projectSessionTerminalPersisted?: boolean;
  /** The producer observed its terminal outcome; raw cleanup may still be settling. */
  terminalOutcomeObserved?: boolean;
  /** Native lifecycle delegates the source's chat error response to detached dispatch. */
  chatErrorDispatchOwned?: true;
  /** A terminal lifecycle event was observed and is awaiting persistence. */
  projectSessionTerminalPending?: boolean;
  /** Store timestamp expected from the observed terminal lifecycle event. */
  projectSessionTerminalObservedAt?: number;
  /** In-flight terminal session-store update used by restart shutdown. */
  projectSessionTerminalPersistence?: Promise<void>;
  /** Which Gateway RPC owns this protocol projection. */
  kind?: "chat-send" | "agent";
};

/** Byte-exact protocol correlation; scheduling and cancellation belong to input. */
export type RpcSourceRef = Readonly<{ input: SessionControllerInput; adapter: RpcSourceAdapter }>;
