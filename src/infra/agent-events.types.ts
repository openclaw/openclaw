import type { AgentEvent } from "../../packages/gateway-protocol/src/schema/agent.js";
import type { AgentRunContext, AgentRunEventState } from "./agent-run-registry.types.js";
import type { captureAgentRunTerminalPersistence } from "./agent-run-terminal-writes.js";

/** Payload for approval requests and their later resolution events. */
export type AgentApprovalEventData = {
  phase: "requested" | "resolved";
  kind: "exec" | "plugin" | "unknown";
  status: "pending" | "unavailable" | "approved" | "denied" | "failed";
  title: string;
  itemId?: string;
  toolCallId?: string;
  approvalId?: string;
  approvalSlug?: string;
  command?: string;
  host?: string;
  reason?: string;
  scope?: "turn" | "session";
  message?: string;
};

/** Stream name for agent events delivered to gateway listeners and plugin host hooks. */
export type AgentEventStream =
  | "lifecycle"
  | "tool"
  | "assistant"
  | "usage"
  | "error"
  | "item"
  | "plan"
  | "approval"
  | "command_output"
  | "patch"
  | "compaction"
  | "thinking"
  | (string & {});

/** Enriched event delivered to subscribers after sequencing and context stamping. */
export type AgentEventPayload = {
  runId: string;
  seq: number;
  stream: AgentEventStream;
  ts: number;
  data: Record<string, unknown>;
  preamble?: AgentEvent["preamble"];
  /** Internal, non-enumerable gateway lifecycle generation that owns this run. */
  lifecycleGeneration?: string;
  sessionKey?: string;
  /**
   * sessionId the run was bound to when it started. Lifecycle persistence uses
   * this to reject terminal events from a pre-`sessions.reset` run that would
   * otherwise clobber the rotated session row resolved by the shared sessionKey.
   */
  sessionId?: string;
  agentId?: string;
};

export type AgentAssistantSourceReceipt = {
  /** Stable occurrence identity for buffer scopes and worker forwarding. */
  itemId?: string;
  /** Undefined until commit; null is durable without an available transcript position. */
  committedMessageSeq?: number | null;
  /** Exact transcript occurrence assigned by the persistence owner after commit. */
  committedMessageId?: string;
};

export type AgentAssistantProjection = {
  itemId: string;
  replace: boolean;
  /** Raw append prepared by the producer; display corrections can differ from HTTP output. */
  rawDelta?: string;
} & ({ text: string; delta?: never } | { delta: string; text?: never });

/** Gateway-only routing metadata stamped onto events after public input validation. */
export type AgentEventRuntimePayload = AgentEventPayload & {
  readonly terminalPersistence?: ReturnType<typeof captureAgentRunTerminalPersistence>;
  readonly admitLifecyclePublication?: () => boolean;
  readonly assistantSource?: AgentAssistantSourceReceipt;
  readonly assistantProjection?: AgentAssistantProjection;
  readonly controlUiVisible?: boolean;
  readonly contextClaimId?: string;
  readonly deliverySessionKey?: string;
  readonly mainSessionRestartRecovery?: true;
  readonly projectSessionLifecycle?: boolean;
  readonly projectSessionMessages?: boolean;
  readonly isHeartbeat?: boolean;
  readonly verboseLevel?: AgentRunContext["verboseLevel"];
  readonly registeredAt?: number;
};

export type AgentEventListener = (
  evt: AgentEventRuntimePayload,
  isDeliveryCurrent?: () => boolean,
) => void;
export type CaptureAgentEventDelivery = (evt: AgentEventRuntimePayload) => () => boolean;
export type AgentEventRegistration = {
  readonly listener: AgentEventListener;
  readonly id: number;
  readonly captureDelivery?: CaptureAgentEventDelivery;
  active: boolean;
};
type AgentEventListeners = { registrations: readonly AgentEventRegistration[] };

export type AgentEventState = {
  runs: Map<string, AgentRunEventState>;
  assistantSources?: WeakMap<object, AgentAssistantSourceReceipt>;
  listeners: AgentEventListeners;
  runListeners: Map<string, AgentEventListeners>;
  nextListenerId: number;
  auditListeners: Set<(evt: AgentEventPayload) => void>;
  lifecycleRotationHandlers?: Map<string, (lifecycleGeneration: string) => void>;
};

export type AgentTerminalEventData = Record<string, unknown> & { phase: "end" | "error" };
export type AgentTerminalEventReservation = {
  publish: (data: AgentTerminalEventData) => void;
  release: () => void;
};
