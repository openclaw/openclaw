/**
 * Hook system for OpenClaw agent events
 *
 * Provides an extensible event-driven hook system for agent events
 * like command processing, session lifecycle, etc.
 */

import type { WorkspaceBootstrapFile } from "../agents/workspace.js";
import type { CliDeps } from "../cli/deps.js";
import type { OpenClawConfig } from "../config/config.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

export type InternalHookEventType = "command" | "session" | "agent" | "gateway" | "message";

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

export type GatewayStartupHookContext = {
  cfg?: OpenClawConfig;
  deps?: CliDeps;
  workspaceDir?: string;
};

export type GatewayStartupHookEvent = InternalHookEvent & {
  type: "gateway";
  action: "startup";
  context: GatewayStartupHookContext;
};

// ============================================================================
// Message Hook Events
// ============================================================================

export type MessageReceivedHookContext = {
  /** Sender identifier (e.g., phone number, user ID) */
  from: string;
  /** Message content */
  content: string;
  /** Unix timestamp when the message was received */
  timestamp?: number;
  /** Channel identifier (e.g., "telegram", "whatsapp") */
  channelId: string;
  /** Provider account ID for multi-account setups */
  accountId?: string;
  /** Conversation/chat ID */
  conversationId?: string;
  /** Message ID from the provider */
  messageId?: string;
  /** Additional provider-specific metadata */
  metadata?: Record<string, unknown>;
};

export type MessageReceivedHookEvent = InternalHookEvent & {
  type: "message";
  action: "received";
  context: MessageReceivedHookContext;
};

export type MessageSentHookContext = {
  /** Recipient identifier */
  to: string;
  /** Message content */
  content: string;
  /** Whether the message was sent successfully */
  success: boolean;
  /** Error message if sending failed */
  error?: string;
  /** Channel identifier (e.g., "telegram", "whatsapp") */
  channelId: string;
  /** Provider account ID for multi-account setups */
  accountId?: string;
  /** Conversation/chat ID */
  conversationId?: string;
  /** Message ID returned by the provider */
  messageId?: string;
};

export type MessageSentHookEvent = InternalHookEvent & {
  type: "message";
  action: "sent";
  context: MessageSentHookContext;
};

export type MessageTranscribedHookContext = {
  /** Sender identifier (e.g., phone number, user ID) */
  from?: string;
  /** Recipient identifier */
  to?: string;
  /** Original raw message body (e.g., "🎤 [Audio]") */
  body?: string;
  /** Enriched body shown to the agent, including transcript */
  bodyForAgent?: string;
  /** The transcribed text from audio */
  transcript: string;
  /** Unix timestamp when the message was received */
  timestamp?: number;
  /** Channel identifier (e.g., "telegram", "whatsapp") */
  channelId: string;
  /** Conversation/chat ID */
  conversationId?: string;
  /** Message ID from the provider */
  messageId?: string;
  /** Sender user ID */
  senderId?: string;
  /** Sender display name */
  senderName?: string;
  /** Sender username */
  senderUsername?: string;
  /** Provider name */
  provider?: string;
  /** Surface name */
  surface?: string;
  /** Path to the media file that was transcribed */
  mediaPath?: string;
  /** MIME type of the media */
  mediaType?: string;
};

export type MessageTranscribedHookEvent = InternalHookEvent & {
  type: "message";
  action: "transcribed";
  context: MessageTranscribedHookContext;
};

export type MessagePreprocessedHookContext = {
  /** Sender identifier (e.g., phone number, user ID) */
  from?: string;
  /** Recipient identifier */
  to?: string;
  /** Original raw message body */
  body?: string;
  /** Fully enriched body shown to the agent (transcripts, image descriptions, link summaries) */
  bodyForAgent?: string;
  /** Transcribed audio text, if the message contained audio */
  transcript?: string;
  /** Unix timestamp when the message was received */
  timestamp?: number;
  /** Channel identifier (e.g., "telegram", "whatsapp") */
  channelId: string;
  /** Conversation/chat ID */
  conversationId?: string;
  /** Message ID from the provider */
  messageId?: string;
  /** Sender user ID */
  senderId?: string;
  /** Sender display name */
  senderName?: string;
  /** Sender username */
  senderUsername?: string;
  /** Provider name */
  provider?: string;
  /** Surface name */
  surface?: string;
  /** Path to the media file, if present */
  mediaPath?: string;
  /** MIME type of the media, if present */
  mediaType?: string;
  /** Whether this message was sent in a group/channel context */
  isGroup?: boolean;
  /** Group or channel identifier, if applicable */
  groupId?: string;
};

export type MessagePreprocessedHookEvent = InternalHookEvent & {
  type: "message";
  action: "preprocessed";
  context: MessagePreprocessedHookContext;
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

export type InternalHookHandler = (event: InternalHookEvent) => Promise<void> | void;

/** Registry of hook handlers by event key */
const handlers = new Map<string, InternalHookHandler[]>();
const log = createSubsystemLogger("internal-hooks");

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
      const message = err instanceof Error ? err.message : String(err);
      log.error(`Hook error [${event.type}:${event.action}]: ${message}`);
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

export function isGatewayStartupEvent(event: InternalHookEvent): event is GatewayStartupHookEvent {
  if (event.type !== "gateway" || event.action !== "startup") {
    return false;
  }
  const context = event.context as GatewayStartupHookContext | null;
  return Boolean(context && typeof context === "object");
}

export function isMessageReceivedEvent(
  event: InternalHookEvent,
): event is MessageReceivedHookEvent {
  if (event.type !== "message" || event.action !== "received") {
    return false;
  }
  const context = event.context as Partial<MessageReceivedHookContext> | null;
  if (!context || typeof context !== "object") {
    return false;
  }
  return typeof context.from === "string" && typeof context.channelId === "string";
}

export function isMessageSentEvent(event: InternalHookEvent): event is MessageSentHookEvent {
  if (event.type !== "message" || event.action !== "sent") {
    return false;
  }
  const context = event.context as Partial<MessageSentHookContext> | null;
  if (!context || typeof context !== "object") {
    return false;
  }
  return (
    typeof context.to === "string" &&
    typeof context.channelId === "string" &&
    typeof context.success === "boolean"
  );
}

export function isMessageTranscribedEvent(
  event: InternalHookEvent,
): event is MessageTranscribedHookEvent {
  if (event.type !== "message" || event.action !== "transcribed") {
    return false;
  }
  const context = event.context as Partial<MessageTranscribedHookContext> | null;
  if (!context || typeof context !== "object") {
    return false;
  }
  return typeof context.transcript === "string" && typeof context.channelId === "string";
}

export function isMessagePreprocessedEvent(
  event: InternalHookEvent,
): event is MessagePreprocessedHookEvent {
  if (event.type !== "message" || event.action !== "preprocessed") {
    return false;
  }
  const context = event.context as Partial<MessagePreprocessedHookContext> | null;
  if (!context || typeof context !== "object") {
    return false;
  }
  return typeof context.channelId === "string";
}
