import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveSessionAgentId } from "../../agents/agent-scope.js";
import { resolveThreadBindingConversationIdFromBindingId } from "../../channels/thread-binding-id.js";
import {
  resolveThreadBindingIdleTimeoutMsForChannel,
  resolveThreadBindingMaxAgeMsForChannel,
} from "../../channels/thread-bindings-policy.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { warnPluginSdkDeprecation } from "../../plugins/sdk-deprecation.js";
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
import { currentConversationBindingPublication } from "./current-conversation-bindings.publication.js";
import type { CurrentConversationBindingBind } from "./current-conversation-bindings.worker-contract.js";
import {
  projectThreadBindingRecord,
  warnLegacySessionBindingMethod,
} from "./session-binding-adapter.js";
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
  registerSessionBindingAdapterV2,
  unregisterSessionBindingAdapter,
  type BindingTargetKind,
  type SessionBindingAdapterV2,
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
 * Released synchronous thread-bindings-runtime SDK contract retained during deprecation.
 * @deprecated Use AccountScopedConversationBindingManagerV2; final compatibility day: 2026-12-31. Removal in the first January 2027 stable release.
 */
export type AccountScopedConversationBindingManager<TKind extends string = string> = {
  accountId: string;
  /** @deprecated Use getByConversationIdAsync on AccountScopedConversationBindingManagerV2; final compatibility day: 2026-12-31. Removal in the first January 2027 stable release. */
  getByConversationId: (
    conversationId: string,
  ) => AccountScopedConversationBindingRecord<TKind> | undefined;
  /** @deprecated Use listBySessionKeyAsync on AccountScopedConversationBindingManagerV2; final compatibility day: 2026-12-31. Removal in the first January 2027 stable release. */
  listBySessionKey: (targetSessionKey: string) => AccountScopedConversationBindingRecord<TKind>[];
  /** @deprecated Use bindConversationAsync on AccountScopedConversationBindingManagerV2; final compatibility day: 2026-12-31. Removal in the first January 2027 stable release. */
  bindConversation: (params: {
    conversationId: string;
    targetKind: BindingTargetKind;
    targetSessionKey: string;
    metadata?: Record<string, unknown>;
  }) => AccountScopedConversationBindingRecord<TKind> | null;
  /** @deprecated Use touchConversationAsync on AccountScopedConversationBindingManagerV2; final compatibility day: 2026-12-31. Removal in the first January 2027 stable release. */
  touchConversation: (
    conversationId: string,
    at?: number,
  ) => AccountScopedConversationBindingRecord<TKind> | null;
  /** @deprecated Use unbindConversationAsync on AccountScopedConversationBindingManagerV2; final compatibility day: 2026-12-31. Removal in the first January 2027 stable release. */
  unbindConversation: (
    conversationId: string,
  ) => AccountScopedConversationBindingRecord<TKind> | null;
  /** @deprecated Use unbindBySessionKeyAsync on AccountScopedConversationBindingManagerV2; final compatibility day: 2026-12-31. Removal in the first January 2027 stable release. */
  unbindBySessionKey: (targetSessionKey: string) => AccountScopedConversationBindingRecord<TKind>[];
  stop: () => void;
};

/** Worker-owned persistence, including reads that expire or normalize stored bindings. */
export type AccountScopedConversationBindingManagerV2<TKind extends string = string> = {
  accountId: string;
  getByConversationIdAsync: (
    conversationId: string,
  ) => Promise<AccountScopedConversationBindingRecord<TKind> | undefined>;
  listBySessionKeyAsync: (
    targetSessionKey: string,
  ) => Promise<AccountScopedConversationBindingRecord<TKind>[]>;
  bindConversationAsync: (
    input: Parameters<AccountScopedConversationBindingManager<TKind>["bindConversation"]>[0],
  ) => Promise<AccountScopedConversationBindingRecord<TKind> | null>;
  touchConversationAsync: (
    conversationId: string,
    at?: number,
  ) => Promise<AccountScopedConversationBindingRecord<TKind> | null>;
  unbindConversationAsync: (
    conversationId: string,
  ) => Promise<AccountScopedConversationBindingRecord<TKind> | null>;
  unbindBySessionKeyAsync: (
    targetSessionKey: string,
  ) => Promise<AccountScopedConversationBindingRecord<TKind>[]>;
  stop: () => void;
};

type AccountBindingOwner<TKind extends string> = {
  manager: AccountScopedConversationBindingManagerV2<TKind>;
  preparation: ReturnType<typeof prepareAccountBindingManager<TKind>>;
  legacy?: AccountScopedConversationBindingManager<TKind>;
};

function getState<TKind extends string>(stateKey: symbol) {
  return resolveGlobalSingleton(stateKey, () => ({
    managersByAccountId: new Map<string, AccountBindingOwner<TKind>>(),
  }));
}

type AccountBindingManagerParams<TKind extends string> = {
  channel: string;
  cfg: OpenClawConfig;
  stateKey: symbol;
  accountId?: string | null;
  toStoredTargetKind: (raw: BindingTargetKind) => TKind;
  toSessionBindingTargetKind: (raw: TKind) => BindingTargetKind;
};

function warnLegacyAccountBindingMethod(
  method: Exclude<keyof AccountScopedConversationBindingManager, "accountId" | "stop">,
): void {
  warnPluginSdkDeprecation({
    family: "conversation-bindings",
    method: `AccountScopedConversationBindingManager.${method}`,
    replacement: `AccountScopedConversationBindingManagerV2.${method}Async`,
    compatibility: "Synchronous binding operations retain commit-before-return compatibility.",
  });
}

/** @deprecated Use createAccountScopedConversationBindingManagerV2; final compatibility day: 2026-12-31. Removal in the first January 2027 stable release. */
export function createAccountScopedConversationBindingManager<TKind extends string>(
  params: AccountBindingManagerParams<TKind>,
): AccountScopedConversationBindingManager<TKind> {
  warnPluginSdkDeprecation({
    family: "conversation-bindings",
    method: "createAccountScopedConversationBindingManager",
    replacement: "createAccountScopedConversationBindingManagerV2",
  });
  const owner = createAccountBindingManager(params);
  if (owner.legacy) {
    return owner.legacy;
  }
  const { accountId, accountScope, conversationRef, asAccountBindingRecord, prepareBind } =
    owner.preparation;
  const legacy: AccountScopedConversationBindingManager<TKind> = {
    accountId,
    getByConversationId: (conversationId) => {
      warnLegacyAccountBindingMethod("getByConversationId");
      const record = resolveCurrentConversationBindingRecord(conversationRef(conversationId));
      return record ? asAccountBindingRecord(record) : undefined;
    },
    listBySessionKey: (targetSessionKey) => {
      warnLegacyAccountBindingMethod("listBySessionKey");
      return listCurrentConversationBindingRecordsBySession(targetSessionKey, accountScope).map(
        asAccountBindingRecord,
      );
    },
    bindConversation: (input) => {
      warnLegacyAccountBindingMethod("bindConversation");
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
      warnLegacyAccountBindingMethod("touchConversation");
      return touchAccountBindingConversation(owner.preparation, conversationId, at);
    },
    unbindConversation: (conversationId) => {
      warnLegacyAccountBindingMethod("unbindConversation");
      const { previous } = updateCurrentConversationBindingRecord(
        conversationRef(conversationId),
        () => null,
      );
      return previous ? asAccountBindingRecord(previous) : null;
    },
    unbindBySessionKey: (targetSessionKey) => {
      warnLegacyAccountBindingMethod("unbindBySessionKey");
      return deleteCurrentConversationBindingRecordsBySession(targetSessionKey, accountScope).map(
        asAccountBindingRecord,
      );
    },
    stop: owner.manager.stop,
  };
  owner.legacy = legacy;
  return legacy;
}

/** Creates the worker-owned manager and registers its required async adapter. */
export function createAccountScopedConversationBindingManagerV2<TKind extends string>(
  params: AccountBindingManagerParams<TKind>,
): AccountScopedConversationBindingManagerV2<TKind> {
  return createAccountBindingManager(params).manager;
}

function prepareAccountBindingManager<TKind extends string>(
  params: AccountBindingManagerParams<TKind>,
) {
  const accountId = normalizeAccountId(params.accountId);
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
  return {
    accountId,
    accountScope,
    idleTimeoutMs,
    maxAgeMs,
    asSessionBindingRecord,
    asAccountBindingRecord,
    conversationRef,
    conversationIdFromBinding,
    prepareBind,
  };
}

function touchAccountBindingConversation<TKind extends string>(
  preparation: ReturnType<typeof prepareAccountBindingManager<TKind>>,
  conversationId: string,
  at: number,
): AccountScopedConversationBindingRecord<TKind> | null {
  const { conversationRef, asAccountBindingRecord, asSessionBindingRecord } = preparation;
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
}

function createAccountBindingManager<TKind extends string>(
  params: AccountBindingManagerParams<TKind>,
): AccountBindingOwner<TKind> {
  const accountId = normalizeAccountId(params.accountId);
  const state = getState<TKind>(params.stateKey);
  const existingManager = state.managersByAccountId.get(accountId);
  if (existingManager) {
    // Manager state is account-scoped and process-global so repeated channel
    // setup calls reuse the same binding adapter instead of double-registering.
    return existingManager;
  }

  const preparation = prepareAccountBindingManager(params);
  const {
    accountScope,
    idleTimeoutMs,
    maxAgeMs,
    asAccountBindingRecord,
    conversationRef,
    conversationIdFromBinding,
    prepareBind,
  } = preparation;
  const assertCurrent = () => {
    if (
      state.managersByAccountId.get(accountId)?.manager !== manager ||
      !isSessionBindingAdapterCurrent(sessionBindingAdapter)
    ) {
      throw new SessionBindingError(
        "BINDING_ADAPTER_UNAVAILABLE",
        "Account conversation binding manager is no longer active",
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
  let publicationRevision = 0;
  const unsubscribePublication = currentConversationBindingPublication.subscribeFacts(() => {
    publicationRevision++;
  });
  const manager: AccountScopedConversationBindingManagerV2<TKind> = {
    getByConversationIdAsync: async (conversationId) => {
      const record = await readAccountBindingAsync(conversationRef(conversationId), false);
      return record ? asAccountBindingRecord(record) : undefined;
    },
    listBySessionKeyAsync: async (targetSessionKey) =>
      (await sessionBindingAdapter.listBySessionAsync(targetSessionKey)).map(
        asAccountBindingRecord,
      ),
    bindConversationAsync: async (input) => {
      const record = await sessionBindingAdapter.bind!({
        ...input,
        conversation: conversationRef(input.conversationId),
      });
      return record ? asAccountBindingRecord(record) : null;
    },
    touchConversationAsync: async (conversationId, at = Date.now()) => {
      const conversation = conversationRef(conversationId);
      const record = await touchCurrentConversationBindingRecordAsync(
        {
          conversation,
          bindingId: `${accountId}:${conversation.conversationId}`,
          at,
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
      return record ? asAccountBindingRecord(record) : null;
    },
    unbindConversationAsync: async (conversationId) => {
      const [record] = await removeCurrentConversationBindingsAsync(
        { conversation: conversationRef(conversationId) },
        assertCurrent,
      );
      return record ? asAccountBindingRecord(record) : null;
    },
    unbindBySessionKeyAsync: async (targetSessionKey) =>
      (
        await removeCurrentConversationBindingsAsync(
          { targetSessionKey, scope: accountScope, genericOnly: false },
          assertCurrent,
        )
      ).map(asAccountBindingRecord),
    accountId,
    stop: () => {
      unsubscribePublication();
      // Registrations are process-local; SQLite-owned bindings must survive manager shutdown.
      if (state.managersByAccountId.get(accountId)?.manager === manager) {
        state.managersByAccountId.delete(accountId);
      }
      unregisterSessionBindingAdapter({
        ...accountScope,
        adapter: sessionBindingAdapter,
      });
    },
  };

  const sessionBindingAdapter: SessionBindingAdapterV2 & NativeSessionBindingReads = {
    version: 2,
    inspectByConversationsAsync: async (refs) => {
      const revision = publicationRevision;
      const assertSnapshotCurrent = () => {
        assertCurrent();
        if (revision !== publicationRevision) {
          throw new Error("Conversation binding publication changed during selection");
        }
      };
      const conversations = refs.map((ref) =>
        matchesAccount(ref) ? conversationRef(ref.conversationId) : null,
      );
      const records = await readCurrentConversationBindingSelectionAsync(
        conversations.filter((ref) => ref !== null),
        assertSnapshotCurrent,
      );
      let index = 0;
      return {
        bindings: conversations.map((ref) => (ref ? (records[index++] ?? null) : null)),
        assertCurrent: assertSnapshotCurrent,
      };
    },
    assertCurrent,
    listBySessionAsync: async (targetSessionKey) =>
      (
        await listCurrentConversationBindingRecordsBySessionsAsync(
          [targetSessionKey],
          accountScope,
          assertCurrent,
        )
      )[0] ?? [],
    channel: params.channel,
    accountId,
    capabilities: { placements: ["current"] },
    /** @deprecated Use listBySessionAsync; final compatibility day: 2026-12-31. Removal in the first January 2027 stable release. */
    listBySession: (targetSessionKey) => {
      warnLegacySessionBindingMethod("listBySession");
      return listCurrentConversationBindingRecordsBySession(targetSessionKey, accountScope);
    },
    /** @deprecated Use resolveByConversationAsync; final compatibility day: 2026-12-31. Removal in the first January 2027 stable release. */
    resolveByConversation: (ref) => {
      warnLegacySessionBindingMethod("resolveByConversation");
      return ref.channel === params.channel
        ? resolveCurrentConversationBindingRecord(conversationRef(ref.conversationId))
        : null;
    },
    /** @deprecated Use touchAsync; final compatibility day: 2026-12-31. Removal in the first January 2027 stable release. */
    touch: (bindingId, at) => {
      warnLegacySessionBindingMethod("touch");
      const conversationId = conversationIdFromBinding(bindingId);
      if (conversationId) {
        touchAccountBindingConversation(preparation, conversationId, at ?? Date.now());
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
    /** @deprecated Use inspectByConversationAsync; final compatibility day: 2026-12-31. Removal in the first January 2027 stable release. */
    inspectByConversation: (ref) => {
      warnLegacySessionBindingMethod("inspectByConversation");
      return ref.channel === params.channel
        ? inspectCurrentConversationBindingRecord(conversationRef(ref.conversationId))
        : null;
    },
    inspectByConversationAsync: (ref) => readAccountBindingAsync(ref, true),
    resolveByConversationAsync: (ref) => readAccountBindingAsync(ref, false),
    touchAsync: async (bindingId, at) => {
      const conversationId = conversationIdFromBinding(bindingId);
      if (conversationId) {
        await manager.touchConversationAsync(conversationId, at);
      }
    },
  };

  registerSessionBindingAdapterV2(sessionBindingAdapter);
  const owner = { manager, preparation };
  state.managersByAccountId.set(accountId, owner);
  return owner;
}

/** Stops registered account-scoped adapters for one test key without clearing durable bindings. */
export function resetAccountScopedConversationBindingsForTests(params: { stateKey: symbol }) {
  const state = getState(params.stateKey);
  for (const { manager } of state.managersByAccountId.values()) {
    manager.stop();
  }
  state.managersByAccountId.clear();
}
