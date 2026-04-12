export type InternalHookEventType =
  | "command"
  | "session"
  | "agent"
  | "gateway"
  | "message"
  | "tool";

export interface InternalHookEvent {
  /** The type of event (command, session, agent, gateway, tool, etc.) */
  type: InternalHookEventType;
  /** The specific action within the type (e.g., 'new', 'reset', 'stop', 'beforeExecute', 'afterExecute') */
  action: string;
  /** The session key this event relates to */
  sessionKey: string;
  /** Additional context specific to the event */
  context: Record<string, unknown>;
  /** Timestamp when the event occurred */
  timestamp: Date;
  /** Messages to send back to the user (hooks can push to this array) */
  messages: string[];
}

export type InternalHookHandler = (event: InternalHookEvent) => Promise<void> | void;

// ============================================================================
// Tool Hook Events (新增)
// ============================================================================

export type ToolBeforeExecuteHookContext = {
  /** Tool name (e.g., 'Bash', 'Read', 'Edit') */
  toolName: string;
  /** Tool input parameters */
  toolInput: Record<string, unknown>;
  /** Tool call ID for tracking */
  toolCallId?: string;
  /** Whether this is a subagent call */
  isSubagent?: boolean;
};

export type ToolBeforeExecuteHookEvent = InternalHookEvent & {
  type: "tool";
  action: "beforeExecute";
  context: ToolBeforeExecuteHookContext;
};

export type ToolAfterExecuteHookContext = {
  /** Tool name (e.g., 'Bash', 'Read', 'Edit') */
  toolName: string;
  /** Tool input parameters */
  toolInput: Record<string, unknown>;
  /** Tool result (success output or error) */
  toolResult?: unknown;
  /** Whether execution resulted in an error */
  isError?: boolean;
  /** Tool call ID for tracking */
  toolCallId?: string;
  /** Whether this is a subagent call */
  isSubagent?: boolean;
};

export type ToolAfterExecuteHookEvent = InternalHookEvent & {
  type: "tool";
  action: "afterExecute";
  context: ToolAfterExecuteHookContext;
};
