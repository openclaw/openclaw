import { resolveThreadBindingConversationIdFromBindingId } from "../../channels/thread-binding-id.js";
import type { SessionBindingAdapter } from "./session-binding-service.js";
import type {
  BindingTargetKind,
  ConversationRef,
  SessionBindingRecord,
} from "./session-binding.types.js";

/** Projects plugin-owned lifecycle facts without normalizing its identity or expiry policy. */
export function projectThreadBindingRecord(
  record: {
    accountId: string;
    targetSessionKey: string;
    boundAt: number;
    lastActivityAt: number;
    agentId?: string;
    label?: string;
    boundBy?: string;
  },
  params: {
    conversation: Omit<ConversationRef, "accountId">;
    bindingId?: string;
    targetKind: BindingTargetKind;
    lifecycle: { expiresAt?: number; idleTimeoutMs: number; maxAgeMs: number };
    metadata?: (lifecycleMetadata: Record<string, unknown>) => Record<string, unknown>;
  },
): SessionBindingRecord {
  const metadata = {
    agentId: record.agentId,
    label: record.label,
    boundBy: record.boundBy,
    lastActivityAt: record.lastActivityAt,
    idleTimeoutMs: params.lifecycle.idleTimeoutMs,
    maxAgeMs: params.lifecycle.maxAgeMs,
  };
  return {
    bindingId: params.bindingId ?? `${record.accountId}:${params.conversation.conversationId}`,
    targetSessionKey: record.targetSessionKey,
    targetKind: params.targetKind,
    conversation: { accountId: record.accountId, ...params.conversation },
    status: "active",
    boundAt: record.boundAt,
    expiresAt: params.lifecycle.expiresAt,
    metadata: params.metadata ? params.metadata(metadata) : metadata,
  };
}

/** Adapts account-prefixed ids while leaving mutations and their settlement with the manager. */
export function createAccountScopedBindingAdapter<T>(params: {
  channel: string;
  accountId: string;
  capabilities: SessionBindingAdapter["capabilities"];
  bind: NonNullable<SessionBindingAdapter["bind"]>;
  project: (record: T) => SessionBindingRecord;
  listBySessionKey: (targetSessionKey: string) => T[];
  getByConversation: (ref: ConversationRef) => T | null | undefined;
  touchConversation: (conversationId: string, at?: number) => unknown;
  touchConversationAsync?: (conversationId: string, at?: number) => Promise<unknown>;
  unbindConversation: (conversationId: string, reason: string) => T | null | Promise<T | null>;
  unbindBySessionKey: (targetSessionKey: string, reason: string) => T[] | Promise<T[]>;
}): SessionBindingAdapter {
  const touchAsync = params.touchConversationAsync;
  const conversationIdFromBinding = (bindingId?: string) =>
    resolveThreadBindingConversationIdFromBindingId({ accountId: params.accountId, bindingId });
  return {
    channel: params.channel,
    accountId: params.accountId,
    capabilities: params.capabilities,
    bind: params.bind,
    listBySession: (sessionKey) => params.listBySessionKey(sessionKey).map(params.project),
    resolveByConversation: (ref) => {
      const record = ref.channel === params.channel ? params.getByConversation(ref) : null;
      return record ? params.project(record) : null;
    },
    touch: (bindingId, at) => {
      const conversationId = conversationIdFromBinding(bindingId);
      if (conversationId) {
        params.touchConversation(conversationId, at);
      }
    },
    ...(touchAsync
      ? {
          touchAsync: async (bindingId: string, at?: number) => {
            const conversationId = conversationIdFromBinding(bindingId);
            if (conversationId) {
              await touchAsync(conversationId, at);
            }
          },
        }
      : {}),
    unbind: async (input) => {
      if (input.targetSessionKey?.trim()) {
        return (await params.unbindBySessionKey(input.targetSessionKey, input.reason)).map(
          params.project,
        );
      }
      const conversationId = conversationIdFromBinding(input.bindingId);
      const removed = conversationId
        ? await params.unbindConversation(conversationId, input.reason)
        : null;
      return removed ? [params.project(removed)] : [];
    },
  };
}
