import { resolveThreadBindingConversationIdFromBindingId } from "../../channels/thread-binding-id.js";
import { warnPluginSdkDeprecation } from "../../plugins/sdk-deprecation.js";
import type { SessionBindingAdapter, SessionBindingAdapterV2 } from "./session-binding-service.js";
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
  // Keep persisted projection bytes aligned with the worker's conversation capture.
  const { channel, ...conversation } = params.conversation;
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
    conversation: { channel, accountId: record.accountId, ...conversation },
    status: "active",
    boundAt: record.boundAt,
    expiresAt: params.lifecycle.expiresAt,
    metadata: params.metadata ? params.metadata(metadata) : metadata,
  };
}

/** @deprecated Use createAccountScopedBindingAdapterV2; removed in the next Plugin SDK major. */
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
    listBySession: (sessionKey) => {
      warnPluginSdkDeprecation({
        family: "conversation-bindings",
        method: "SessionBindingAdapter.listBySession",
        replacement: "SessionBindingAdapterV2.listBySessionAsync",
      });
      return params.listBySessionKey(sessionKey).map(params.project);
    },
    resolveByConversation: (ref) => {
      warnPluginSdkDeprecation({
        family: "conversation-bindings",
        method: "SessionBindingAdapter.resolveByConversation",
        replacement: "SessionBindingAdapterV2.resolveByConversationAsync",
      });
      const record = ref.channel === params.channel ? params.getByConversation(ref) : null;
      return record ? params.project(record) : null;
    },
    touch: (bindingId, at) => {
      warnPluginSdkDeprecation({
        family: "conversation-bindings",
        method: "SessionBindingAdapter.touch",
        replacement: "SessionBindingAdapterV2.touchAsync",
      });
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

/** Keeps worker operations and legacy synchronous compatibility views on the same owner. */
export function createAccountScopedBindingAdapterV2<T>(
  params: Parameters<typeof createAccountScopedBindingAdapter<T>>[0] & {
    assertCurrent: () => void;
    /** Reads one coherent published projection and certifies its source until consumption. */
    inspectByConversations: (refs: readonly ConversationRef[]) => {
      records: readonly (T | null | undefined)[];
      assertCurrent: () => void;
    };
    listBySessionKeyAsync: (targetSessionKey: string) => Promise<T[]>;
    getByConversationAsync: (ref: ConversationRef) => Promise<T | null | undefined>;
    inspectByConversationAsync: (ref: ConversationRef) => Promise<T | null | undefined>;
    touchConversationAsync: (conversationId: string, at?: number) => Promise<unknown>;
  },
): SessionBindingAdapterV2 {
  const project = async (ref: ConversationRef, read: typeof params.getByConversationAsync) => {
    params.assertCurrent();
    const record = ref.channel === params.channel ? await read(ref) : null;
    params.assertCurrent();
    return record ? params.project(record) : null;
  };
  return {
    ...createAccountScopedBindingAdapter(params),
    version: 2,
    inspectByConversationsAsync: async (refs) => {
      params.assertCurrent();
      const snapshot = params.inspectByConversations(refs);
      return {
        bindings: snapshot.records.map((record) => (record ? params.project(record) : null)),
        assertCurrent: () => {
          params.assertCurrent();
          snapshot.assertCurrent();
        },
      };
    },
    touchAsync: async (bindingId, at) => {
      params.assertCurrent();
      const conversationId = resolveThreadBindingConversationIdFromBindingId({
        accountId: params.accountId,
        bindingId,
      });
      if (conversationId) {
        await params.touchConversationAsync(conversationId, at);
      }
      params.assertCurrent();
    },
    assertCurrent: params.assertCurrent,
    listBySessionAsync: async (sessionKey) => {
      params.assertCurrent();
      const records = await params.listBySessionKeyAsync(sessionKey);
      params.assertCurrent();
      return records.map(params.project);
    },
    resolveByConversationAsync: (ref) => project(ref, params.getByConversationAsync),
    inspectByConversationAsync: (ref) => project(ref, params.inspectByConversationAsync),
  };
}
