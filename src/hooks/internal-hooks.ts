/**
 * Hook system for OpenClaw agent events
 *
 * Provides an extensible event-driven hook system for agent events
 * like command processing, session lifecycle, etc.
 */

import type { WorkspaceBootstrapFile } from "../agents/workspace.js";
import type { OpenClawConfig } from "../config/config.js";

/**
 * Internal hook event types.
 * - command, session, agent, gateway: existing system-level events
 * - UserPromptSubmit: fired when user submits a prompt (before processing)
 * - PreToolUse: fired before a tool is executed
 * - PostToolUse: fired after a tool execution completes
 * - Stop: fired when agent processing is stopped
 * - PreCompact: fired before context compaction
 */
export type InternalHookEventType =
  | "command"
  | "session"
  | "agent"
  | "gateway"
  | "UserPromptSubmit"
  | "PreToolUse"
  | "PostToolUse"
  | "Stop"
  | "PreCompact";

export type AgentBootstrapHookContext = {
  workspaceDir: string;
  bootstrapFiles: WorkspaceBootstrapFile[];
  cfg?: OpenClawConfig;
  sessionKey?: string;
  sessionId?: string;
  agentId?: string;
};

export type AgentBootstrapHookEvent = InternalHookEvent & {
  type: "agent";
  action: "bootstrap";
  context: AgentBootstrapHookContext;
};

// ============================================================================
// Claude Code-style agent-level hook event contexts
// ============================================================================

/**
 * Context for UserPromptSubmit event.
 * Fired when user submits a prompt, before any processing begins.
 */
export type UserPromptSubmitContext = {
  /** The raw user prompt text */
  prompt: string;
  /** Session identifier */
  sessionId: string;
  /** Agent identifier */
  agentId?: string;
  /** Working directory for the agent */
  workspaceDir?: string;
  /** Provider being used (e.g., 'anthropic', 'openai') */
  provider?: string;
  /** Model being used */
  model?: string;
};

export type UserPromptSubmitHookEvent = InternalHookEvent & {
  type: "UserPromptSubmit";
  action: "submit";
  context: UserPromptSubmitContext;
};

/**
 * Context for PreToolUse event.
 * Fired before a tool is executed.
 */
export type PreToolUseContext = {
  /** Tool name (e.g., 'Bash', 'Read', 'Write') */
  toolName: string;
  /** Tool input parameters as JSON-serializable object */
  toolInput: Record<string, unknown>;
  /** Session identifier */
  sessionId: string;
  /** Agent identifier */
  agentId?: string;
  /** Working directory for the agent */
  workspaceDir?: string;
};

export type PreToolUseHookEvent = InternalHookEvent & {
  type: "PreToolUse";
  action: "pre";
  context: PreToolUseContext;
};

/**
 * Context for PostToolUse event.
 * Fired after a tool execution completes.
 */
export type PostToolUseContext = {
  /** Tool name (e.g., 'Bash', 'Read', 'Write') */
  toolName: string;
  /** Tool input parameters that were used */
  toolInput: Record<string, unknown>;
  /** Tool output/result (may be truncated for large outputs) */
  toolOutput?: string;
  /** Exit code for shell commands, or success indicator */
  exitCode?: number;
  /** Whether the tool execution was successful */
  success: boolean;
  /** Error message if execution failed */
  error?: string;
  /** Execution duration in milliseconds */
  durationMs?: number;
  /** Session identifier */
  sessionId: string;
  /** Agent identifier */
  agentId?: string;
  /** Working directory for the agent */
  workspaceDir?: string;
};

export type PostToolUseHookEvent = InternalHookEvent & {
  type: "PostToolUse";
  action: "post";
  context: PostToolUseContext;
};

/**
 * Context for Stop event.
 * Fired when agent processing is stopped (user interrupt or natural completion).
 */
export type StopContext = {
  /** Reason for stopping */
  reason: "user_interrupt" | "completion" | "error" | "timeout" | "max_turns";
  /** Session identifier */
  sessionId: string;
  /** Agent identifier */
  agentId?: string;
  /** Number of turns completed */
  turnsCompleted?: number;
  /** Total tokens used in the session */
  totalTokens?: number;
  /** Final response text (if available) */
  finalResponse?: string;
};

export type StopHookEvent = InternalHookEvent & {
  type: "Stop";
  action: "stop";
  context: StopContext;
};

/**
 * Context for PreCompact event.
 * Fired before context compaction (conversation summarization).
 */
export type PreCompactContext = {
  /** Session identifier */
  sessionId: string;
  /** Agent identifier */
  agentId?: string;
  /** Current context token count before compaction */
  currentTokens: number;
  /** Target token count after compaction */
  targetTokens: number;
  /** Number of messages in conversation */
  messageCount: number;
};

export type PreCompactHookEvent = InternalHookEvent & {
  type: "PreCompact";
  action: "pre";
  context: PreCompactContext;
};

// ============================================================================
// Hook handler types with output support
// ============================================================================

/**
 * Handler that can return output to be collected.
 * Return value will be collected by triggerInternalHookWithOutput.
 */
export type InternalHookHandlerWithOutput = (
  event: InternalHookEvent,
) => Promise<string | undefined> | string | undefined;

export interface InternalHookEvent {
  /** The type of event (command, session, agent, gateway, etc.) */
  type: InternalHookEventType;
  /** The specific action within the type (e.g., 'new', 'reset', 'stop') */
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

/** Registry of hook handlers by event key */
const handlers = new Map<string, InternalHookHandler[]>();

/**
 * Register a hook handler for a specific event type or event:action combination
 *
 * @param eventKey - Event type (e.g., 'command') or specific action (e.g., 'command:new')
 * @param handler - Function to call when the event is triggered
 *
 * @example
 * ```ts
 * // Listen to all command events
 * registerInternalHook('command', async (event) => {
 *   console.log('Command:', event.action);
 * });
 *
 * // Listen only to /new commands
 * registerInternalHook('command:new', async (event) => {
 *   await saveSessionToMemory(event);
 * });
 * ```
 */
export function registerInternalHook(eventKey: string, handler: InternalHookHandler): void {
  if (!handlers.has(eventKey)) {
    handlers.set(eventKey, []);
  }
  handlers.get(eventKey)!.push(handler);
}

/**
 * Unregister a specific hook handler
 *
 * @param eventKey - Event key the handler was registered for
 * @param handler - The handler function to remove
 */
export function unregisterInternalHook(eventKey: string, handler: InternalHookHandler): void {
  const eventHandlers = handlers.get(eventKey);
  if (!eventHandlers) {
    return;
  }

  const index = eventHandlers.indexOf(handler);
  if (index !== -1) {
    eventHandlers.splice(index, 1);
  }

  // Clean up empty handler arrays
  if (eventHandlers.length === 0) {
    handlers.delete(eventKey);
  }
}

/**
 * Clear all registered hooks (useful for testing)
 */
export function clearInternalHooks(): void {
  handlers.clear();
}

/**
 * Get all registered event keys (useful for debugging)
 */
export function getRegisteredEventKeys(): string[] {
  return Array.from(handlers.keys());
}

/**
 * Trigger a hook event
 *
 * Calls all handlers registered for:
 * 1. The general event type (e.g., 'command')
 * 2. The specific event:action combination (e.g., 'command:new')
 *
 * Handlers are called in registration order. Errors are caught and logged
 * but don't prevent other handlers from running.
 *
 * @param event - The event to trigger
 */
export async function triggerInternalHook(event: InternalHookEvent): Promise<void> {
  const typeHandlers = handlers.get(event.type) ?? [];
  const specificHandlers = handlers.get(`${event.type}:${event.action}`) ?? [];

  const allHandlers = [...typeHandlers, ...specificHandlers];

  if (allHandlers.length === 0) {
    return;
  }

  for (const handler of allHandlers) {
    try {
      await handler(event);
    } catch (err) {
      console.error(
        `Hook error [${event.type}:${event.action}]:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }
}

/** Registry of hook handlers that return output */
const handlersWithOutput = new Map<string, InternalHookHandlerWithOutput[]>();

/**
 * Register a hook handler that can return output.
 * Output from handlers will be collected by triggerInternalHookWithOutput.
 *
 * @param eventKey - Event type or event:action combination
 * @param handler - Handler that may return a string output
 */
export function registerInternalHookWithOutput(
  eventKey: string,
  handler: InternalHookHandlerWithOutput,
): void {
  if (!handlersWithOutput.has(eventKey)) {
    handlersWithOutput.set(eventKey, []);
  }
  handlersWithOutput.get(eventKey)!.push(handler);
}

/**
 * Unregister a hook handler with output
 */
export function unregisterInternalHookWithOutput(
  eventKey: string,
  handler: InternalHookHandlerWithOutput,
): void {
  const eventHandlers = handlersWithOutput.get(eventKey);
  if (!eventHandlers) {
    return;
  }

  const index = eventHandlers.indexOf(handler);
  if (index !== -1) {
    eventHandlers.splice(index, 1);
  }

  if (eventHandlers.length === 0) {
    handlersWithOutput.delete(eventKey);
  }
}

/**
 * Clear all registered hooks with output (useful for testing)
 */
export function clearInternalHooksWithOutput(): void {
  handlersWithOutput.clear();
}

/**
 * Hook result with deny support.
 * Used by triggerInternalHookWithOutput to indicate if a hook denied the action.
 */
export type InternalHookWithOutputResult = {
  /** Collected output strings from handlers */
  outputs: string[];
  /** Whether any handler denied the action (exit code 2) */
  denied: boolean;
  /** Deny reason if denied */
  denyReason?: string;
};

/**
 * Trigger a hook event and collect output from handlers.
 *
 * Calls both regular handlers (for side effects) and output handlers (for stdout collection).
 * Output handlers are treated as returning potential stdout content.
 *
 * @param event - The event to trigger
 * @returns Result with collected outputs and deny status
 */
export async function triggerInternalHookWithOutput(
  event: InternalHookEvent,
): Promise<InternalHookWithOutputResult> {
  // First trigger regular handlers for side effects
  await triggerInternalHook(event);

  // Then collect output from output handlers
  const typeHandlers = handlersWithOutput.get(event.type) ?? [];
  const specificHandlers = handlersWithOutput.get(`${event.type}:${event.action}`) ?? [];
  const allHandlers = [...typeHandlers, ...specificHandlers];

  const result: InternalHookWithOutputResult = {
    outputs: [],
    denied: false,
  };

  if (allHandlers.length === 0) {
    return result;
  }

  for (const handler of allHandlers) {
    try {
      const output = await handler(event);
      if (output !== undefined && output !== null && output !== "") {
        result.outputs.push(output);
      }
    } catch (err) {
      // Special handling: if error message starts with "DENY:", mark as denied
      const errMsg = err instanceof Error ? err.message : String(err);
      if (errMsg.startsWith("DENY:")) {
        result.denied = true;
        result.denyReason = errMsg.slice(5).trim();
        break; // Stop processing on deny
      }
      console.error(`Hook error [${event.type}:${event.action}]:`, errMsg);
    }
  }

  return result;
}

/**
 * Create a hook event with common fields filled in
 *
 * @param type - The event type
 * @param action - The action within that type
 * @param sessionKey - The session key
 * @param context - Additional context
 */
export function createInternalHookEvent(
  type: InternalHookEventType,
  action: string,
  sessionKey: string,
  context: Record<string, unknown> = {},
): InternalHookEvent {
  return {
    type,
    action,
    sessionKey,
    context,
    timestamp: new Date(),
    messages: [],
  };
}

export function isAgentBootstrapEvent(event: InternalHookEvent): event is AgentBootstrapHookEvent {
  if (event.type !== "agent" || event.action !== "bootstrap") {
    return false;
  }
  const context = event.context as Partial<AgentBootstrapHookContext> | null;
  if (!context || typeof context !== "object") {
    return false;
  }
  if (typeof context.workspaceDir !== "string") {
    return false;
  }
  return Array.isArray(context.bootstrapFiles);
}
