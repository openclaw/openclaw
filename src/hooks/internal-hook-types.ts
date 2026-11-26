import type { SessionsPatchParams } from "../../packages/gateway-protocol/src/schema/sessions.js";
import type { WorkspaceBootstrapFile } from "../agents/workspace.js";
import type { CliDeps } from "../cli/outbound-send-deps.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { MessageHookMediaFact } from "./message-hook-media.js";

export type InternalHookEventType = "command" | "session" | "agent" | "gateway" | "message";

const KNOWN_INTERNAL_HOOK_EVENT_FAMILIES = [
  "command",
  "session",
  "agent",
  "gateway",
  "message",
] as const satisfies readonly InternalHookEventType[];

/**
 * Event keys emitted by core trigger sites (see docs/automation/hooks.md
 * events table — keep both in sync when adding a trigger). Hooks can also
 * subscribe to a bare family key to receive every action of that family.
 * Plugins can emit additional keys via the deprecated plugin-sdk/hook-runtime
 * barrel, so anything outside this set is flagged as a likely typo
 * (advisory), not rejected.
 */
const KNOWN_INTERNAL_HOOK_EVENT_KEYS = [
  "agent:bootstrap",
  "command:new",
  "command:reset",
  "command:stop",
  "gateway:pre-restart",
  "gateway:shutdown",
  "gateway:startup",
  "message:preprocessed",
  "message:received",
  "message:sent",
  "message:transcribed",
  "session:auto-reset",
  "session:compact:after",
  "session:compact:before",
  "session:patch",
] as const;

export function isKnownInternalHookEventKey(key: string): boolean {
  return (
    (KNOWN_INTERNAL_HOOK_EVENT_KEYS as readonly string[]).includes(key) ||
    (KNOWN_INTERNAL_HOOK_EVENT_FAMILIES as readonly string[]).includes(key)
  );
}

export interface InternalHookEvent {
  type: InternalHookEventType;
  /** The specific action within the type (e.g., 'new', 'reset', 'stop') */
  action: string;
  sessionKey: string;
  context: Record<string, unknown>;
  timestamp: Date;
  /** Messages to send back to the user (hooks can push to this array) */
  messages: string[];
}

export type InternalHookHandler = (event: InternalHookEvent) => Promise<void> | void;

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

type GatewayStartupHookContext = {
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
  error?: string;
  isGroup?: boolean;
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
  transcript: string;
};

export type MessagePreprocessedHookContext = MessageEnrichedBodyHookContext & {
  transcript?: string;
  isGroup?: boolean;
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
