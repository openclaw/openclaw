/** Metadata-only durable audit contract for agent runs and tool actions. */

export type AuditEventKind = "agent_run" | "tool_action";

export type AuditEventAction =
  | "agent.run.started"
  | "agent.run.finished"
  | "tool.action.started"
  | "tool.action.finished";

export type AuditEventStatus =
  | "started"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "timed_out"
  | "blocked";

export type AuditEventErrorCode =
  | "run_failed"
  | "run_cancelled"
  | "run_timed_out"
  | "run_blocked"
  | "tool_failed"
  | "tool_cancelled"
  | "tool_timed_out"
  | "tool_blocked";

export type AuditEventActorType = "agent" | "system";

/** Durable columns accepted from trusted lifecycle projection. */
export type AuditEventInput = {
  sourceSequence: number;
  occurredAt: number;
  kind: AuditEventKind;
  action: AuditEventAction;
  status: AuditEventStatus;
  errorCode?: AuditEventErrorCode;
  actorType: AuditEventActorType;
  actorId: string;
  agentId: string;
  sessionKey?: string;
  sessionId?: string;
  runId: string;
  toolCallId?: string;
  toolName?: string;
};

/** Public record returned by the bounded operator read surface. */
export type AuditEventRecord = AuditEventInput & {
  sequence: number;
  eventId: string;
  redaction: "metadata_only";
};

export type AuditEventListFilters = {
  agentId?: string;
  sessionKey?: string;
  runId?: string;
  kind?: AuditEventKind;
  status?: AuditEventStatus;
  after?: number;
  before?: number;
};

export type AuditEventListPage = {
  events: AuditEventRecord[];
  nextCursor?: number;
};
