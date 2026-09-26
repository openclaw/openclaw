import type { SessionsPatchParams } from "../../packages/gateway-protocol/src/schema/sessions.js";
import type { WorkspaceBootstrapFile } from "../agents/workspace.js";
import type { CliDeps } from "../cli/outbound-send-deps.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  clearLegacyPluginInternalHooks,
  listLegacyPluginInternalHookEventKeys,
  listLegacyPluginInternalHooks,
} from "../plugins/legacy-internal-hook-state.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import type {
  InternalHookEvent,
  InternalHookEventType,
  InternalHookHandler,
} from "./internal-hook-types.js";
import type { MessageHookMediaFact } from "./message-hook-media.js";
export type { InternalHookEvent, InternalHookEventType, InternalHookHandler };

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

export type MessageReceivedHookContext = {
  /** Sender identifier (e.g., phone number, user ID) */
  from: string;
  content: string;
  /** Unix timestamp when the message was received */
  timestamp?: number;
  /** Channel identifier (for example "chat" or "support-chat") */
  channelId: string;
  /** Provider account ID for multi-account setups */
  accountId?: string;
  conversationId?: string;
  /** Message ID from the provider */
  messageId?: string;
  /** Staged, locally usable attachments in stable source order. */
  media?: MessageHookMediaFact[];
  /** Original attachment facts when local staging has not completed yet. */
  originalMedia?: MessageHookMediaFact[];
  /** True when originalMedia is present but media is withheld pending staging. */
  mediaStagingPending?: boolean;
  /** Additional provider-specific metadata */
  metadata?: Record<string, unknown>;
};

export type MessageSentHookContext = Pick<
  MessageReceivedHookContext,
  "content" | "channelId" | "accountId" | "conversationId" | "messageId"
> & {
  to: string;
  success: boolean;
  /** Error message if sending failed */
  error?: string;
  /** Whether this message was sent in a group/channel context */
  isGroup?: boolean;
  /** Group or channel identifier, if applicable */
  groupId?: string;
};

type MessageEnrichedBodyHookContext = Pick<
  MessageReceivedHookContext,
  | "timestamp"
  | "channelId"
  | "conversationId"
  | "messageId"
  | "media"
  | "originalMedia"
  | "mediaStagingPending"
> & {
  /** Sender identifier (e.g., phone number, user ID) */
  from?: string;
  to?: string;
  /** Original raw message body (e.g., "🎤 [Audio]") */
  body?: string;
  /** Enriched body shown to the agent, including transcript */
  bodyForAgent?: string;
  senderId?: string;
  senderName?: string;
  senderUsername?: string;
  provider?: string;
  surface?: string;
  /** @deprecated Use `media?.[0]?.path`. */
  mediaPath?: string;
  /** @deprecated Use `media?.[0]?.contentType` or `.kind`. */
  mediaType?: string;
};

export type MessageTranscribedHookContext = MessageEnrichedBodyHookContext & {
  /** The transcribed text from audio */
  transcript: string;
};

export type MessagePreprocessedHookContext = MessageEnrichedBodyHookContext & {
  /** Transcribed audio text, if the message contained audio */
  transcript?: string;
  /** Whether this message was sent in a group/channel context */
  isGroup?: boolean;
  /** Group or channel identifier, if applicable */
  groupId?: string;
};

export type SessionPatchHookContext = {
  sessionEntry: SessionEntry;
  patch: SessionsPatchParams;
  cfg: OpenClawConfig;
};

export type SessionPatchHookEvent = InternalHookEvent & {
  type: "session";
  action: "patch";
  context: SessionPatchHookContext;
};

// Share registrations across copies of this module emitted into separate bundle chunks.
const INTERNAL_HOOK_HANDLERS_KEY = Symbol.for("openclaw.internalHookHandlers");
const handlers = resolveGlobalSingleton<Map<string, InternalHookHandler[]>>(
  INTERNAL_HOOK_HANDLERS_KEY,
  () => new Map<string, InternalHookHandler[]>(),
);
const INTERNAL_HOOKS_ENABLED_KEY = Symbol.for("openclaw.internalHooksEnabled");
const internalHooksEnabledState = resolveGlobalSingleton<{ enabled: boolean }>(
  INTERNAL_HOOKS_ENABLED_KEY,
  () => ({ enabled: true }),
);
const log = createSubsystemLogger("internal-hooks");

/** Register for a family (e.g. "command") or an exact action (e.g. "command:new"). */
export function registerInternalHook(eventKey: string, handler: InternalHookHandler): void {
  if (!handlers.has(eventKey)) {
    handlers.set(eventKey, []);
  }
  handlers.get(eventKey)!.push(handler);
}

export function unregisterInternalHook(eventKey: string, handler: InternalHookHandler): void {
  const eventHandlers = handlers.get(eventKey);
  if (!eventHandlers) {
    return;
  }

  const index = eventHandlers.indexOf(handler);
  if (index !== -1) {
    eventHandlers.splice(index, 1);
  }

  if (eventHandlers.length === 0) {
    handlers.delete(eventKey);
  }
}

export function clearInternalHooks(): void {
  handlers.clear();
  clearLegacyPluginInternalHooks();
}

export function setInternalHooksEnabled(enabled: boolean): void {
  internalHooksEnabledState.enabled = enabled;
}

export function getRegisteredEventKeys(): string[] {
  return [...new Set([...handlers.keys(), ...listLegacyPluginInternalHookEventKeys()])];
}

export function hasInternalHookListeners(type: InternalHookEventType, action: string): boolean {
  return (
    (handlers.get(type)?.length ?? 0) + listLegacyPluginInternalHooks(type).length > 0 ||
    (handlers.get(`${type}:${action}`)?.length ?? 0) +
      listLegacyPluginInternalHooks(`${type}:${action}`).length >
      0
  );
}

/** Dispatch family handlers before exact-action handlers, in registration order; isolate errors. */
export async function triggerInternalHook(event: InternalHookEvent): Promise<void> {
  if (!internalHooksEnabledState.enabled) {
    return;
  }
  // An admitted event finishes its snapshot even if a handler awaits across a reload or disable.
  const specificKey = `${event.type}:${event.action}`;
  const allHandlers = [
    ...(handlers.get(event.type) ?? []),
    ...listLegacyPluginInternalHooks(event.type),
    ...(handlers.get(specificKey) ?? []),
    ...listLegacyPluginInternalHooks(specificKey),
  ];

  for (const handler of allHandlers) {
    try {
      await handler(event);
    } catch (err) {
      const message = formatErrorMessage(err);
      log.error(`Hook error [${event.type}:${event.action}]: ${message}`);
    }
  }
}

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

function hasHookEventContext(
  event: InternalHookEvent,
  type: InternalHookEventType,
  action: string,
): boolean {
  return (
    event.type === type &&
    event.action === action &&
    event.context !== null &&
    typeof event.context === "object"
  );
}

export function isAgentBootstrapEvent(event: InternalHookEvent): event is AgentBootstrapHookEvent {
  return (
    hasHookEventContext(event, "agent", "bootstrap") &&
    typeof event.context.workspaceDir === "string" &&
    Array.isArray(event.context.bootstrapFiles)
  );
}

export function isGatewayStartupEvent(event: InternalHookEvent): event is GatewayStartupHookEvent {
  return hasHookEventContext(event, "gateway", "startup");
}

export function isSessionPatchEvent(event: InternalHookEvent): event is SessionPatchHookEvent {
  if (!hasHookEventContext(event, "session", "patch")) {
    return false;
  }
  const context = event.context;
  return (
    typeof context.patch === "object" &&
    context.patch !== null &&
    typeof context.cfg === "object" &&
    context.cfg !== null &&
    typeof context.sessionEntry === "object" &&
    context.sessionEntry !== null
  );
}
