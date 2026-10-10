import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveSessionAgentId } from "../../agents/agent-scope.js";
import { resolveThreadBindingConversationIdFromBindingId } from "../../channels/thread-binding-id.js";
import {
  resolveThreadBindingIdleTimeoutMsForChannel,
  resolveThreadBindingMaxAgeMsForChannel,
} from "../../channels/thread-bindings-policy.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { normalizeAccountId } from "../../routing/session-key.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import {
  bindCurrentConversationRecordAsync,
  removeCurrentConversationBindingsAsync,
  deleteCurrentConversationBindingRecordsBySession,
  inspectCurrentConversationBindingRecordAsync,
  readCurrentConversationBindingSelectionAsync,
  resolveCurrentConversationBindingRecordAsync,
  touchCurrentConversationBindingRecordAsync,
  listCurrentConversationBindingRecordsBySession,
  listCurrentConversationBindingRecordsBySessionsAsync,
  resolveCurrentConversationBindingRecord,
  inspectCurrentConversationBindingRecord,
  updateCurrentConversationBindingRecord,
} from "./current-conversation-bindings.js";
import { applyCurrentConversationBindingBind } from "./current-conversation-bindings.kernel.js";
import type { CurrentConversationBindingBind } from "./current-conversation-bindings.worker-contract.js";
import { projectThreadBindingRecord } from "./session-binding-adapter.js";
import { SessionBindingError } from "./session-binding-errors.js";
import {
  expectedCurrentSessionBinding,
  type CurrentSessionBindingExpectation,
  nativeSessionBindingInspection,
  nativeSessionBindingSelection,
  nativeSessionBindingListBySessions,
  type NativeSessionBindingReads,
} from "./session-binding-native-selection.js";
import { normalizeConversationRef } from "./session-binding-normalization.js";
import {
  isSessionBindingAdapterCurrent,
  registerSessionBindingAdapter,
  unregisterSessionBindingAdapter,
  type BindingTargetKind,
  type SessionBindingAdapter,
  type SessionBindingRecord,
} from "./session-binding-service.js";
import type {
  ConversationRef,
  SessionBindingBindInput,
  SessionBindingUnbindInput,
} from "./session-binding.types.js";

/** Binding record scoped to one channel account and conversation id. */
export type AccountScopedConversationBindingRecord<TKind extends string = string> = {
  accountId: string;
  conversationId: string;
  targetKind: TKind;
  targetSessionKey: string;
  agentId?: string;
  label?: string;
  boundBy?: string;
  boundAt: number;
  lastActivityAt: number;
};

/**
 * Released synchronous thread-bindings-runtime SDK contract, retained until the next SDK major.
 * Bundled session-binding adapters use the worker operations below.
 */
export type AccountScopedConversationBindingManager<TKind extends string = string> = {
  accountId: string;
  getByConversationId: (
    conversationId: string,
  ) => AccountScopedConversationBindingRecord<TKind> | undefined;
  listBySessionKey: (targetSessionKey: string) => AccountScopedConversationBindingRecord<TKind>[];
  bindConversation: (params: {
    conversationId: string;
    targetKind: BindingTargetKind;
    targetSessionKey: string;
    metadata?: Record<string, unknown>;
  }) => AccountScopedConversationBindingRecord<TKind> | null;
  touchConversation: (
    conversationId: string,
    at?: number,
  ) => AccountScopedConversationBindingRecord<TKind> | null;
  unbindConversation: (
    conversationId: string,
  ) => AccountScopedConversationBindingRecord<TKind> | null;
  unbindBySessionKey: (targetSessionKey: string) => AccountScopedConversationBindingRecord<TKind>[];
  stop: () => void;
};

function getState<TKind extends string>(stateKey: symbol) {
  return resolveGlobalSingleton(stateKey, () => ({
    managersByAccountId: new Map<string, AccountScopedConversationBindingManager<TKind>>(),
  }));
}

/** Creates a channel/account binding manager and registers it as a session-binding adapter. */
export function createAccountScopedConversationBindingManager<TKind extends string>(params: {
  channel: string;
  cfg: OpenClawConfig;
  stateKey: symbol;
  accountId?: string | null;
  toStoredTargetKind: (raw: BindingTargetKind) => TKind;
  toSessionBindingTargetKind: (raw: TKind) => BindingTargetKind;
}): AccountScopedConversationBindingManager<TKind> {
  const accountId = normalizeAccountId(params.accountId);
  const state = getState<TKind>(params.stateKey);
  const existingManager = state.managersByAccountId.get(accountId);
  if (existingManager) {
    // Manager state is account-scoped and process-global so repeated channel
    // setup calls reuse the same binding adapter instead of double-registering.
    return existingManager;
  }

  const accountScope = { channel: params.channel, accountId };
  const policyScope = { cfg: params.cfg, ...accountScope };
  const idleTimeoutMs = resolveThreadBindingIdleTimeoutMsForChannel(policyScope);
  const maxAgeMs = resolveThreadBindingMaxAgeMsForChannel(policyScope);
  const asSessionBindingRecord = (
    record: AccountScopedConversationBindingRecord<TKind>,
    metadata?: Record<string, unknown>,
  ): SessionBindingRecord => {
    const idleExpiresAt = idleTimeoutMs > 0 ? record.lastActivityAt + idleTimeoutMs : undefined;
    const maxAgeExpiresAt = maxAgeMs > 0 ? record.boundAt + maxAgeMs : undefined;
    const expiresAt =
      idleExpiresAt != null && maxAgeExpiresAt != null
        ? Math.min(idleExpiresAt, maxAgeExpiresAt)
        : (idleExpiresAt ?? maxAgeExpiresAt);
    return projectThreadBindingRecord(record, {
      conversation: {
        channel: params.channel,
        conversationId: record.conversationId,
      },
      targetKind: params.toSessionBindingTargetKind(record.targetKind),
      lifecycle: { expiresAt, idleTimeoutMs, maxAgeMs },
      metadata: (lifecycleMetadata) => ({ ...metadata, ...lifecycleMetadata }),
    });
  };
  const conversationRef = (conversationId: string) =>
    normalizeConversationRef({ ...accountScope, conversationId });
  const conversationIdFromBinding = (bindingId?: string) =>
    resolveThreadBindingConversationIdFromBindingId({ accountId, bindingId });
  const asAccountBindingRecord = (
    record: SessionBindingRecord,
  ): AccountScopedConversationBindingRecord<TKind> => {
    const metadata = record.metadata;
    return {
      accountId,
      conversationId: record.conversation.conversationId,
      targetKind: params.toStoredTargetKind(record.targetKind),
      targetSessionKey: record.targetSessionKey,
      agentId: typeof metadata?.agentId === "string" ? metadata.agentId : undefined,
      label: typeof metadata?.label === "string" ? metadata.label : undefined,
      boundBy: typeof metadata?.boundBy === "string" ? metadata.boundBy : undefined,
      boundAt: record.boundAt,
      lastActivityAt:
        typeof metadata?.lastActivityAt === "number" ? metadata.lastActivityAt : record.boundAt,
    };
  };
  const prepareBind = (
    input: Parameters<AccountScopedConversationBindingManager<TKind>["bindConversation"]>[0],
  ): (CurrentConversationBindingBind & { assertAgentResolved?: () => void }) | null => {
    const conversationId = input.conversationId.trim();
    const targetSessionKey = input.targetSessionKey.trim();
    if (!conversationId || !targetSessionKey) {
      return null;
    }
    const now = Date.now();
    let inferredAgentId: string | undefined;
    let assertAgentResolved: (() => void) | undefined;
    try {
      inferredAgentId = resolveSessionAgentId({ config: params.cfg, sessionKey: targetSessionKey });
    } catch (error) {
      // The committed row may supply plugin ownership or an explicit agent, making inference unnecessary.
      assertAgentResolved = () => {
        throw error;
      };
    }
    return {
      assertAgentResolved,
      record: asSessionBindingRecord(
        {
          accountId,
          conversationId,
          targetKind: params.toStoredTargetKind(input.targetKind),
          targetSessionKey,
          agentId: normalizeOptionalString(input.metadata?.agentId),
          label: normalizeOptionalString(input.metadata?.label),
          boundBy: normalizeOptionalString(input.metadata?.boundBy),
          boundAt: now,
          lastActivityAt: now,
        },
        input.metadata,
      ),
      accountPolicy: { inferredAgentId },
    };
  };
  const assertCurrent = () => {
    if (
      state.managersByAccountId.get(accountId) !== manager ||
      !isSessionBindingAdapterCurrent(sessionBindingAdapter)
    ) {
      throw new SessionBindingError(
        "BINDING_ADAPTER_UNAVAILABLE",
        "Account conversation binding manager is no longer active",
        { channel: params.channel, accountId },
      );
    }
  };
  const matchesAccount = (ref: ConversationRef) => {
    const normalized = normalizeConversationRef(ref);
    return normalized.channel === params.channel && normalized.accountId === accountId;
  };
  const readAccountBindingAsync = async (ref: ConversationRef, inspect: boolean) => {
    if (!matchesAccount(ref)) {
      return null;
    }
    if (inspect) {
      assertCurrent();
    }
    const record = inspect
      ? await inspectCurrentConversationBindingRecordAsync(conversationRef(ref.conversationId))
      : await resolveCurrentConversationBindingRecordAsync(
          conversationRef(ref.conversationId),
          assertCurrent,
        );
    assertCurrent();
    return record;
  };
  const manager: AccountScopedConversationBindingManager<TKind> = {
    accountId,
    getByConversationId: (conversationId) => {
      const record = resolveCurrentConversationBindingRecord(conversationRef(conversationId));
      return record ? asAccountBindingRecord(record) : undefined;
    },
    listBySessionKey: (targetSessionKey) =>
      listCurrentConversationBindingRecordsBySession(targetSessionKey, accountScope).map(
        asAccountBindingRecord,
      ),
    bindConversation: (input) => {
      const prepared = prepareBind(input);
      const record = prepared
        ? updateCurrentConversationBindingRecord(prepared.record.conversation, (current) =>
            applyCurrentConversationBindingBind(current, prepared, (requiresAgentId) => {
              if (requiresAgentId) {
                prepared.assertAgentResolved?.();
              }
            }),
          ).current
        : null;
      return record ? asAccountBindingRecord(record) : null;
    },
    touchConversation: (conversationId, at = Date.now()) => {
      const { current } = updateCurrentConversationBindingRecord(
        conversationRef(conversationId),
        (existing) => {
          if (!existing) {
            return null;
          }
          const updated = { ...asAccountBindingRecord(existing), lastActivityAt: at };
          return asSessionBindingRecord(updated, existing.metadata);
        },
      );
      return current ? asAccountBindingRecord(current) : null;
    },
    unbindConversation: (conversationId) => {
      const { previous } = updateCurrentConversationBindingRecord(
        conversationRef(conversationId),
        () => null,
      );
      return previous ? asAccountBindingRecord(previous) : null;
    },
    unbindBySessionKey: (targetSessionKey) =>
      deleteCurrentConversationBindingRecordsBySession(targetSessionKey, accountScope).map(
        asAccountBindingRecord,
      ),
    stop: () => {
      // Registrations are process-local; SQLite-owned bindings must survive manager shutdown.
      if (state.managersByAccountId.get(accountId) === manager) {
        state.managersByAccountId.delete(accountId);
      }
      unregisterSessionBindingAdapter({
        ...accountScope,
        adapter: sessionBindingAdapter,
      });
    },
  };

  const sessionBindingAdapter: SessionBindingAdapter & NativeSessionBindingReads = {
    channel: params.channel,
    accountId,
    capabilities: { placements: ["current"] },
    listBySession: (targetSessionKey) =>
      listCurrentConversationBindingRecordsBySession(targetSessionKey, accountScope),
    resolveByConversation: (ref) =>
      ref.channel === params.channel
        ? resolveCurrentConversationBindingRecord(conversationRef(ref.conversationId))
        : null,
    touch: (bindingId, at) => {
      const conversationId = conversationIdFromBinding(bindingId);
      if (conversationId) {
        manager.touchConversation(conversationId, at);
      }
    },
    bind: async (input: SessionBindingBindInput & CurrentSessionBindingExpectation) => {
      if (input.conversation.channel !== params.channel || input.placement === "child") {
        return null;
      }
      const prepared = prepareBind({
        conversationId: input.conversation.conversationId,
        targetKind: input.targetKind,
        targetSessionKey: input.targetSessionKey,
        metadata: input.metadata,
      });
      return prepared
        ? bindCurrentConversationRecordAsync(
            {
              ...prepared,
              expected: input[expectedCurrentSessionBinding],
            },
            () => {
              assertCurrent();
              input.assertCurrent?.();
            },
            prepared.assertAgentResolved,
          )
        : null;
    },
    unbind: async (input: SessionBindingUnbindInput & CurrentSessionBindingExpectation) => {
      if (input.targetSessionKey?.trim()) {
        return removeCurrentConversationBindingsAsync(
          {
            targetSessionKey: input.targetSessionKey.trim(),
            scope: accountScope,
            genericOnly: false,
          },
          assertCurrent,
        );
      }
      const conversationId = conversationIdFromBinding(input.bindingId);
      return conversationId
        ? removeCurrentConversationBindingsAsync(
            {
              conversation: conversationRef(conversationId),
              expected: input[expectedCurrentSessionBinding],
            },
            assertCurrent,
          )
        : [];
    },
    [nativeSessionBindingInspection]: {
      capture: (ref) => (matchesAccount(ref) ? conversationRef(ref.conversationId) : null),
      assertCurrent,
    },
    [nativeSessionBindingSelection]: async (refs) => {
      const conversations = refs.map((ref) =>
        matchesAccount(ref) ? conversationRef(ref.conversationId) : null,
      );
      assertCurrent();
      const records = await readCurrentConversationBindingSelectionAsync(
        conversations.filter((ref) => ref !== null),
        assertCurrent,
      );
      assertCurrent();
      let index = 0;
      return conversations.map((ref) => (ref ? (records[index++] ?? null) : null));
    },
    [nativeSessionBindingListBySessions]: (targetSessionKeys, context) =>
      listCurrentConversationBindingRecordsBySessionsAsync(
        targetSessionKeys,
        accountScope,
        assertCurrent,
        context,
      ),
    inspectByConversation: (ref) =>
      ref.channel === params.channel
        ? inspectCurrentConversationBindingRecord(conversationRef(ref.conversationId))
        : null,
    inspectByConversationAsync: (ref) => readAccountBindingAsync(ref, true),
    resolveByConversationAsync: (ref) => readAccountBindingAsync(ref, false),
    touchAsync: async (bindingId, at) => {
      const conversationId = conversationIdFromBinding(bindingId);
      if (conversationId) {
        await touchCurrentConversationBindingRecordAsync(
          {
            conversation: conversationRef(conversationId),
            bindingId,
            at: at === undefined ? Date.now() : at,
            accountPolicy: {
              idleTimeoutMs,
              maxAgeMs,
              targetKinds: {
                subagent: params.toSessionBindingTargetKind(params.toStoredTargetKind("subagent")),
                session: params.toSessionBindingTargetKind(params.toStoredTargetKind("session")),
              },
            },
          },
          assertCurrent,
        );
      }
    },
  };

  registerSessionBindingAdapter(sessionBindingAdapter);
  state.managersByAccountId.set(accountId, manager);
  return manager;
}

/** Stops registered account-scoped adapters for one test key without clearing durable bindings. */
export function resetAccountScopedConversationBindingsForTests(params: { stateKey: symbol }) {
  const state = getState(params.stateKey);
  for (const manager of state.managersByAccountId.values()) {
    manager.stop();
  }
  state.managersByAccountId.clear();
}
