import type { AgentRunContext } from "./agent-run-registry.types.js";

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
};

export type AgentAssistantProjection = {
  itemId: string;
  text: string;
  replace: boolean;
};

/** Gateway-only routing metadata stamped onto events after public input validation. */
export type AgentEventRuntimePayload = AgentEventPayload & {
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
