import { AsyncLocalStorage } from "node:async_hooks";

export type ServerContext = {
  /** Organization identifier (primary tenant ID) */
  orgId: string;
  /** User identifier */
  userId: string;
  /** Agent identifier */
  agentId?: string;
  /** Session identifier */
  sessionId?: string;
  /** Request correlation ID */
  correlationId?: string;
  /** Workspace identifier (multi-tenant hierarchy) */
  workspaceId?: string;
  /** Team identifier (multi-tenant hierarchy) */
  teamId?: string;
  /** Message channel/surface (whatsapp, telegram, webchat, etc.) */
  channel?: string;
  /** Channel-specific metadata */
  channelMetadata?: {
    /** Phone number for WhatsApp/SMS */
    phoneNumber?: string;
    /** Chat ID for Telegram/Discord */
    chatId?: string;
    /** Group name or chat title */
    chatTitle?: string;
    /** Whether this is a group/channel vs DM */
    isGroup?: boolean;
    /** Additional channel-specific fields */
    [key: string]: unknown;
  };
  /** Custom application metadata */
  metadata?: {
    /** Conversation background/context */
    conversationContext?: string;
    /** User preferences */
    preferences?: Record<string, unknown>;
    /** Any additional fields */
    [key: string]: unknown;
  };
};

const storage = new AsyncLocalStorage<ServerContext>();

export function runWithServerContext<T>(ctx: ServerContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

export function getServerContext(): ServerContext | undefined {
  return storage.getStore();
}

export function requireServerContext(): ServerContext {
  const ctx = storage.getStore();
  if (!ctx) {
    throw new Error("Server context not found (AsyncLocalStorage is empty)");
  }
  return ctx;
}
