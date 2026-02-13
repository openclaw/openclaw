/**
 * Hook system for OpenClaw agent events
 *
 * Provides an extensible event-driven hook system for agent events
 * like command processing, session lifecycle, etc.
 */

import type { WorkspaceBootstrapFile } from "../agents/workspace.js";
import type { OpenClawConfig } from "../config/config.js";

export type InternalHookEventType =
  | "command"
  | "session"
  | "agent"
  | "gateway"
  | "model"
  | "message";

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

export type ModelSelectHookContext = {
  /** Original requested provider */
  requestedProvider: string;
  /** Original requested model */
  requestedModel: string;
  /** Resolved candidates after applying strategy */
  candidates: Array<{ provider: string; model: string }>;
  /** Selection strategy being used */
  strategy: string;
  /** Session key for context */
  sessionKey?: string;
  /** Agent ID if available */
  agentId?: string;
  /** Workspace directory */
  workspaceDir?: string;
  /** Estimated context length (tokens) */
  contextLength?: number;
  /** Task hint from caller (e.g., "code", "chat", "summary") */
  taskHint?: string;
};

export type ModelSelectHookEvent = InternalHookEvent & {
  type: "model";
  action: "select";
  context: ModelSelectHookContext;
};

export type ModelSelectHookResult = {
  /** Override the selected model */
  overrideModel?: string;
  /** Override the entire candidate list */
  overrideCandidates?: Array<{ provider: string; model: string }>;
  /** Add candidates to the front of the list */
  prependCandidates?: Array<{ provider: string; model: string }>;
};

export type ModelFailoverHookContext = {
  fromProvider: string;
  fromModel: string;
  toProvider: string;
  toModel: string;
  reason: string;
  errorMessage?: string;
  statusCode?: number;
  attemptNumber: number;
  totalCandidates: number;
  agentId?: string;
  workspaceDir?: string;
};

export type ModelFailoverHookEvent = InternalHookEvent & {
  type: "model";
  action: "failover";
  context: ModelFailoverHookContext;
};

export type ModelFailoverHookResult = {
  allow?: boolean;
  vetoReason?: string;
  overrideTarget?: string;
};

// =============================================================================
// Message Hooks - Time Tunnel 時光隧道
// =============================================================================

export type MessageHookContext = {
  /** Message direction */
  direction: "inbound" | "outbound";
  /** Channel (telegram, line, discord, etc.) */
  channel: string;
  /** Chat ID */
  chatId: string;
  /** Chat type (group, dm, channel) */
  chatType?: string;
  /** Chat name if available */
  chatName?: string;
  /** Sender ID */
  senderId?: string;
  /** Sender name */
  senderName?: string;
  /** Message ID */
  messageId?: string;
  /** Reply to message ID */
  replyToId?: string;
  /** Text content */
  content?: string;
  /** Media type if present */
  mediaType?: string;
  /** Media URL if present */
  mediaUrl?: string;
  /** Session key */
  sessionKey?: string;
  /** Agent ID */
  agentId?: string;
  /** Workspace directory */
  workspaceDir?: string;
  /** Raw event data (stringified, truncated) */
  rawEvent?: string;
};

export type MessageReceivedHookEvent = InternalHookEvent & {
  type: "message";
  action: "received";
  context: MessageHookContext;
};

export type MessageSentHookEvent = InternalHookEvent & {
  type: "message";
  action: "sent";
  context: MessageHookContext;
};

export type ModelCompleteHookContext = {
  /** Provider that handled the request */
  provider: string;
  /** Model that handled the request */
  model: string;
  /** Input tokens used */
  inputTokens?: number;
  /** Output tokens generated */
  outputTokens?: number;
  /** Cache read tokens */
  cacheReadTokens?: number;
  /** Cache write tokens */
  cacheWriteTokens?: number;
  /** Total duration in milliseconds */
  durationMs?: number;
  /** Whether the request succeeded */
  success: boolean;
  /** Error message if failed */
  errorMessage?: string;
  /** Session key */
  sessionKey?: string;
  /** Agent ID */
  agentId?: string;
  /** Workspace directory */
  workspaceDir?: string;
};

export type ModelCompleteHookEvent = InternalHookEvent & {
  type: "model";
  action: "complete";
  context: ModelCompleteHookContext;
};

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

export type InternalHookHandler = (
  event: InternalHookEvent,
) => Promise<void | ModelFailoverHookResult> | void | ModelFailoverHookResult;

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

export function isModelFailoverEvent(event: InternalHookEvent): event is ModelFailoverHookEvent {
  if (event.type !== "model" || event.action !== "failover") {
    return false;
  }
  const context = event.context as Partial<ModelFailoverHookContext> | null;
  if (!context || typeof context !== "object") {
    return false;
  }
  return (
    typeof context.fromProvider === "string" &&
    typeof context.fromModel === "string" &&
    typeof context.toProvider === "string" &&
    typeof context.toModel === "string"
  );
}

export function isModelSelectEvent(event: InternalHookEvent): event is ModelSelectHookEvent {
  if (event.type !== "model" || event.action !== "select") {
    return false;
  }
  const context = event.context as Partial<ModelSelectHookContext> | null;
  if (!context || typeof context !== "object") {
    return false;
  }
  return (
    typeof context.requestedProvider === "string" &&
    typeof context.requestedModel === "string" &&
    Array.isArray(context.candidates)
  );
}

export function isModelCompleteEvent(event: InternalHookEvent): event is ModelCompleteHookEvent {
  if (event.type !== "model" || event.action !== "complete") {
    return false;
  }
  const context = event.context as Partial<ModelCompleteHookContext> | null;
  if (!context || typeof context !== "object") {
    return false;
  }
  return typeof context.provider === "string" && typeof context.model === "string";
}

/**
 * Trigger model select hook and collect results
 *
 * Called before model selection to allow smart routing decisions.
 */
export async function triggerModelSelectHook(
  event: ModelSelectHookEvent,
): Promise<ModelSelectHookResult | undefined> {
  const typeHandlers = handlers.get(event.type) ?? [];
  const specificHandlers = handlers.get(`${event.type}:${event.action}`) ?? [];
  const allHandlers = [...typeHandlers, ...specificHandlers];

  if (allHandlers.length === 0) {
    return undefined;
  }

  let result: ModelSelectHookResult | undefined;

  for (const handler of allHandlers) {
    try {
      const handlerResult = await handler(event);
      if (handlerResult && typeof handlerResult === "object") {
        const typed = handlerResult as ModelSelectHookResult;
        result = {
          overrideModel: typed.overrideModel ?? result?.overrideModel,
          overrideCandidates: typed.overrideCandidates ?? result?.overrideCandidates,
          prependCandidates: typed.prependCandidates ?? result?.prependCandidates,
        };
      }
    } catch (err) {
      console.error(
        `Hook error [${event.type}:${event.action}]:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  return result;
}

/**
 * Trigger model failover hook and collect results
 *
 * Unlike other internal hooks, this one collects results from handlers
 * to allow veto/override behavior.
 */
export async function triggerModelFailoverHook(
  event: ModelFailoverHookEvent,
): Promise<ModelFailoverHookResult | undefined> {
  const typeHandlers = handlers.get(event.type) ?? [];
  const specificHandlers = handlers.get(`${event.type}:${event.action}`) ?? [];
  const allHandlers = [...typeHandlers, ...specificHandlers];

  if (allHandlers.length === 0) {
    return undefined;
  }

  let result: ModelFailoverHookResult | undefined;

  for (const handler of allHandlers) {
    try {
      const handlerResult = await handler(event);
      // Merge results if handler returns something
      if (handlerResult && typeof handlerResult === "object") {
        const typed = handlerResult;
        result = {
          allow: typed.allow ?? result?.allow,
          vetoReason: typed.vetoReason ?? result?.vetoReason,
          overrideTarget: typed.overrideTarget ?? result?.overrideTarget,
        };
      }
    } catch (err) {
      console.error(
        `Hook error [${event.type}:${event.action}]:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  return result;
}

/**
 * Trigger model complete hook (fire-and-forget)
 *
 * Called after a model request completes (success or failure) for tracking/metrics.
 */
export async function triggerModelCompleteHook(event: ModelCompleteHookEvent): Promise<void> {
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

/**
 * Trigger message received hook (fire-and-forget)
 *
 * Called when a message is received from any channel.
 */
export async function triggerMessageReceivedHook(event: MessageReceivedHookEvent): Promise<void> {
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

/**
 * Trigger message sent hook (fire-and-forget)
 *
 * Called when a message is sent to any channel.
 */
export async function triggerMessageSentHook(event: MessageSentHookEvent): Promise<void> {
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

export function isMessageReceivedEvent(
  event: InternalHookEvent,
): event is MessageReceivedHookEvent {
  return event.type === "message" && event.action === "received";
}

export function isMessageSentEvent(event: InternalHookEvent): event is MessageSentHookEvent {
  return event.type === "message" && event.action === "sent";
}
