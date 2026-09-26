// Generic current-conversation bindings persist lightweight conversation ->
// session links for plugin channels without a custom binding adapter.
import {
  asDateTimestampMs,
  resolveExpiresAtMsFromDurationMs,
} from "@openclaw/normalization-core/number-coercion";
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import { normalizeConversationText } from "../../acp/conversation-id.js";
import { normalizeAnyChannelId } from "../../channels/registry.js";
import {
  getActivePluginChannelRegistryFromState,
  getActivePluginChannelRegistrySnapshotFromState,
} from "../../plugins/runtime-channel-state.js";
import {
  executeExistingOpenClawStateRead,
  withExistingOpenClawStateDatabaseReadOnly,
} from "../../state/openclaw-state-db-readonly.js";
import type { DB as OpenClawStateKyselyDatabase } from "../../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import { runOpenClawStateWorkerOperation } from "../../state/openclaw-state-worker-store.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../../utils/message-channel-constants.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../kysely-sync.js";
import { createSqliteWorkerWriteAdmission } from "../sqlite-worker-store.js";
import {
  CURRENT_BINDINGS_ID_PREFIX,
  buildBindingId,
  bindingRowsToRecords,
  isBindingExpired,
  deleteCurrentConversationBindingRow,
  listCurrentConversationBindingRowsBySession,
  readCurrentConversationBindingListInDatabase,
  pruneCurrentConversationBindingListInTransaction,
  updateCurrentConversationBindingRecordInDatabase,
  inspectCurrentConversationBindingRecordInDatabase,
  readCurrentConversationBindingResolutionInDatabase,
  type CurrentConversationBindingScope,
} from "./current-conversation-bindings.kernel.js";
import type { CurrentConversationBindingTouch } from "./current-conversation-bindings.worker-contract.js";
import { SessionBindingError } from "./session-binding-errors.js";
import {
  buildChannelAccountKey,
  captureConversationRef,
  normalizeConversationRef,
} from "./session-binding-normalization.js";
import type {
  ConversationRef,
  SessionBindingBindInput,
  SessionBindingCapabilities,
  SessionBindingRecord,
  SessionBindingScope,
  SessionBindingUnbindInput,
} from "./session-binding.types.js";

/** Updates one binding from its currently committed row in one synchronous transaction. */
export function updateCurrentConversationBindingRecord(
  ref: ConversationRef,
  update: (current: SessionBindingRecord | null) => SessionBindingRecord | null,
): { previous: SessionBindingRecord | null; current: SessionBindingRecord | null } {
  const conversation = normalizeConversationRef(ref);
  return runOpenClawStateWriteTransaction(({ db }) =>
    updateCurrentConversationBindingRecordInDatabase(db, conversation, update),
  );
}

/** Selects the current row without pruning expiry or rewriting legacy keys. */
export function inspectCurrentConversationBindingRecord(
  ref: ConversationRef,
): SessionBindingRecord | null {
  const conversation = normalizeConversationRef(ref);
  return (
    withExistingOpenClawStateDatabaseReadOnly(({ db }) =>
      inspectCurrentConversationBindingRecordInDatabase(db, conversation),
    ) ?? null
  );
}

/** Reads the latest durable binding and prunes only the exact expired conversation row. */
export function resolveCurrentConversationBindingRecord(
  ref: ConversationRef,
): SessionBindingRecord | null {
  const { db } = openOpenClawStateDatabase();
  const conversation = normalizeConversationRef(ref);
  const result = readCurrentConversationBindingResolutionInDatabase(db, conversation);
  return result.repair
    ? updateCurrentConversationBindingRecord(conversation, (current) => current).current
    : result.record;
}

/** Lists latest durable bindings using the exact target key and optional account scope. */
export function listCurrentConversationBindingRecordsBySession(
  targetSessionKey: string,
  scope?: CurrentConversationBindingScope,
): SessionBindingRecord[] {
  const { db } = openOpenClawStateDatabase();
  const prepared = readCurrentConversationBindingListInDatabase(db, targetSessionKey, scope);
  return prepared.requiresPrune
    ? runOpenClawStateWriteTransaction(({ db: transactionDb }) =>
        pruneCurrentConversationBindingListInTransaction(transactionDb, targetSessionKey, scope),
      )
    : prepared.records;
}

/** Awaited listing retains the existing create-on-first-use and expiry-prune behavior. */
export async function listCurrentConversationBindingRecordsBySessionAsync(
  targetSessionKey: string,
  scope?: CurrentConversationBindingScope,
  assertCurrent?: () => void,
): Promise<SessionBindingRecord[]> {
  const capturedScope = scope ? { channel: scope.channel, accountId: scope.accountId } : undefined;
  const context = captureOpenClawStateWorkerContext();
  const records = await runOpenClawStateWorkerOperation(
    context,
    (worker) =>
      worker.execute({
        type: "conversationBindings.listBySession",
        input: { targetSessionKey, ...(capturedScope ? { scope: capturedScope } : {}) },
      }),
    {
      assertCurrent,
      requireStateLifecycle: true,
      createAdmission: createSqliteWorkerWriteAdmission(() => {
        context.admission.assertCurrent();
        assertCurrent?.();
      }, [context.admission.databasePath]),
    },
  );
  context.admission.assertCurrent();
  assertCurrent?.();
  return records;
}

/** Deletes exact account-owned or generic session rows without disturbing sibling owners. */
export function deleteCurrentConversationBindingRecordsBySession(
  targetSessionKey: string,
  scope?: CurrentConversationBindingScope,
  genericOnly = !scope,
): SessionBindingRecord[] {
  return runOpenClawStateWriteTransaction(({ db }) => {
    const rows = listCurrentConversationBindingRowsBySession(
      db,
      targetSessionKey,
      scope,
      genericOnly,
    );
    const removed: SessionBindingRecord[] = [];
    for (const row of rows) {
      const record = bindingRowsToRecords([row])[0];
      if (genericOnly && !record?.bindingId.startsWith(CURRENT_BINDINGS_ID_PREFIX)) {
        continue;
      }
      deleteCurrentConversationBindingRow(db, row.binding_key);
      if (record && !isBindingExpired(record)) {
        removed.push(record);
      }
    }
    return removed;
  });
}

function resolveChannelConversationBindingSupport(params: SessionBindingScope) {
  const normalized =
    normalizeAnyChannelId(params.channel) ??
    normalizeOptionalLowercaseString(normalizeConversationText(params.channel));
  if (!normalized) {
    return undefined;
  }
  const matchesPluginId = (plugin: {
    id?: string | null;
    meta?: { aliases?: readonly string[] } | null;
  }) =>
    plugin.id === normalized ||
    (plugin.meta?.aliases ?? []).some(
      (alias) => normalizeOptionalLowercaseString(alias) === normalized,
    );
  // Read the already-installed runtime channel registry from shared state only.
  // Importing plugins/runtime here creates a module cycle through plugin-sdk
  // surfaces during bundled channel discovery.
  const plugin = (getActivePluginChannelRegistryFromState()?.channels ?? []).find((entry) =>
    matchesPluginId(entry.plugin),
  )?.plugin;
  return plugin?.conversationBindings;
}

function resolveChannelSupportsCurrentConversationBinding(params: SessionBindingScope): boolean {
  const bindingSupport = resolveChannelConversationBindingSupport(params);
  if (
    bindingSupport?.supportsCurrentConversationBinding !== true ||
    bindingSupport.bindingStore === "adapter" ||
    typeof bindingSupport.createManager === "function"
  ) {
    return false;
  }
  return (
    bindingSupport.isCurrentConversationBindingSupported?.({ accountId: params.accountId }) ?? true
  );
}

/** True when an active channel lifecycle owns bindings through a registered adapter. */
export function requiresRegisteredSessionBindingAdapter(params: SessionBindingScope): boolean {
  const support = resolveChannelConversationBindingSupport(params);
  return support?.bindingStore === "adapter" || typeof support?.createManager === "function";
}

function supportsGenericCurrentConversationBinding(ref: SessionBindingScope): boolean {
  const normalized = normalizeConversationRef({
    ...ref,
    conversationId: "capability-check",
  });
  if (normalized.channel === INTERNAL_MESSAGE_CHANNEL) {
    return true;
  }
  return resolveChannelSupportsCurrentConversationBinding({
    channel: normalized.channel,
    accountId: normalized.accountId,
  });
}

function bindingRefFromId(bindingId: string, scope?: SessionBindingScope): ConversationRef | null {
  if (!bindingId.startsWith(CURRENT_BINDINGS_ID_PREFIX)) {
    return null;
  }
  const [channel, accountId, parentConversationId, conversationId] = bindingId
    .slice(CURRENT_BINDINGS_ID_PREFIX.length)
    .split("\u241f");
  if (!channel || !accountId || !conversationId) {
    return null;
  }
  if (scope && buildChannelAccountKey({ channel, accountId }) !== buildChannelAccountKey(scope)) {
    return null;
  }
  return {
    channel,
    accountId,
    conversationId,
    ...(parentConversationId ? { parentConversationId } : {}),
  };
}

/** Reports generic current-conversation binding support for plugin-owned channels. */
export function getGenericCurrentConversationBindingCapabilities(
  params: SessionBindingScope,
): SessionBindingCapabilities | null {
  if (!supportsGenericCurrentConversationBinding(params)) {
    return null;
  }
  return {
    adapterAvailable: true,
    bindSupported: true,
    unbindSupported: true,
    placements: ["current"],
  };
}

/** Stores or replaces the current-conversation binding for a normalized conversation ref. */
export async function bindGenericCurrentConversation(
  input: SessionBindingBindInput,
): Promise<SessionBindingRecord | null> {
  const assertCurrent = input.assertCurrent;
  const conversation = normalizeConversationRef(input.conversation);
  const targetSessionKey = input.targetSessionKey.trim();
  if (
    !conversation.channel ||
    !conversation.conversationId ||
    !targetSessionKey ||
    !supportsGenericCurrentConversationBinding(conversation)
  ) {
    return null;
  }
  const rawNow = Date.now();
  const now = asDateTimestampMs(rawNow);
  if (now === undefined) {
    return null;
  }
  const ttlMs =
    typeof input.ttlMs === "number" && Number.isFinite(input.ttlMs)
      ? Math.max(0, Math.floor(input.ttlMs))
      : undefined;
  const expiresAt =
    ttlMs === undefined
      ? undefined
      : ttlMs === 0
        ? now
        : resolveExpiresAtMsFromDurationMs(ttlMs, { nowMs: rawNow });
  if (ttlMs !== undefined && expiresAt === undefined) {
    return null;
  }
  return updateCurrentConversationBindingRecord(conversation, (existing) => {
    assertCurrent?.();
    return {
      bindingId: buildBindingId(conversation),
      targetSessionKey,
      targetKind: input.targetKind,
      conversation,
      status: "active",
      boundAt: now,
      ...(expiresAt !== undefined ? { expiresAt } : {}),
      metadata: {
        ...(existing?.targetSessionKey === targetSessionKey &&
        existing.targetKind === input.targetKind
          ? existing.metadata
          : undefined),
        ...input.metadata,
        lastActivityAt: now,
      },
    };
  }).current;
}

/** Inspects generic ownership without extending activity or cleaning stored rows. */
export function inspectGenericCurrentConversationBinding(
  ref: ConversationRef,
): SessionBindingRecord | null {
  if (!supportsGenericCurrentConversationBinding(ref)) {
    return null;
  }
  const record = inspectCurrentConversationBindingRecord(ref);
  return record?.bindingId.startsWith(CURRENT_BINDINGS_ID_PREFIX) ? record : null;
}

/** Resolves a current-conversation binding and prunes it if its TTL has expired. */
export function resolveGenericCurrentConversationBinding(
  ref: ConversationRef,
): SessionBindingRecord | null {
  if (!supportsGenericCurrentConversationBinding(ref)) {
    return null;
  }
  const record = resolveCurrentConversationBindingRecord(ref);
  return record?.bindingId.startsWith(CURRENT_BINDINGS_ID_PREFIX) ? record : null;
}

/** Lists non-expired current-conversation bindings owned by one target session. */
export function listGenericCurrentConversationBindingsBySession(
  targetSessionKey: string,
): SessionBindingRecord[] {
  return listCurrentConversationBindingRecordsBySession(targetSessionKey).filter(
    (record) =>
      record.bindingId.startsWith(CURRENT_BINDINGS_ID_PREFIX) &&
      supportsGenericCurrentConversationBinding(record.conversation),
  );
}

/** Persists last-activity metadata for an existing generic current-conversation binding. */
export function touchGenericCurrentConversationBinding(
  bindingId: string,
  at = Date.now(),
  scope?: SessionBindingScope,
): void {
  const conversation = bindingRefFromId(bindingId, scope);
  if (!conversation || !supportsGenericCurrentConversationBinding(conversation)) {
    return;
  }
  updateCurrentConversationBindingRecord(conversation, (current) =>
    current?.bindingId === bindingId
      ? {
          ...current,
          metadata: {
            ...current.metadata,
            lastActivityAt: at,
          },
        }
      : current,
  );
}

function unbindCurrentConversationBindingById(
  bindingId: string,
  scope?: SessionBindingScope,
): SessionBindingRecord[] {
  const conversation = bindingRefFromId(bindingId, scope);
  if (!conversation || !supportsGenericCurrentConversationBinding(conversation)) {
    return [];
  }
  const { previous, current } = updateCurrentConversationBindingRecord(conversation, (latest) =>
    latest?.bindingId === bindingId ? null : latest,
  );
  return previous && !current ? [previous] : [];
}

/** Removes generic current-conversation bindings by binding id or target session key. */
export async function unbindGenericCurrentConversationBindings(
  input: SessionBindingUnbindInput,
): Promise<SessionBindingRecord[]> {
  const normalizedBindingId = input.bindingId?.trim();
  if (normalizedBindingId?.startsWith(CURRENT_BINDINGS_ID_PREFIX)) {
    return unbindCurrentConversationBindingById(normalizedBindingId, input.scope);
  }
  const normalizedTargetSessionKey = input.targetSessionKey?.trim();
  return normalizedTargetSessionKey
    ? deleteCurrentConversationBindingRecordsBySession(
        normalizedTargetSessionKey,
        input.scope,
        true,
      )
    : [];
}

/** Reads committed state without creating the store, pruning expiry, or repairing rows. */
export async function inspectCurrentConversationBindingRecordAsync(
  ref: ConversationRef,
): Promise<SessionBindingRecord | null> {
  const conversation = captureConversationRef(ref);
  const result = await executeExistingOpenClawStateRead(
    {},
    { type: "conversationBindings.inspect", conversation },
  );
  if (!result) {
    return null;
  }
  if (!result.ok || result.type !== "conversationBindings.inspect") {
    throw new Error("Unexpected current conversation binding inspection result");
  }
  return result.record;
}

export async function resolveCurrentConversationBindingRecordAsync(
  ref: ConversationRef,
  assertCurrent?: () => void,
): Promise<SessionBindingRecord | null> {
  const conversation = captureConversationRef(ref);
  const context = captureOpenClawStateWorkerContext();
  const result = await runOpenClawStateWorkerOperation(
    context,
    (scope) => scope.execute({ type: "conversationBindings.resolve", input: conversation }),
    {
      assertCurrent,
      createAdmission: createSqliteWorkerWriteAdmission(() => {
        context.admission.assertCurrent();
        assertCurrent?.();
      }, [context.admission.databasePath]),
    },
  );
  context.admission.assertCurrent();
  assertCurrent?.();
  return result;
}

/** Reads one live ordered selection without repairing rows or inheriting discovery snapshots. */
export async function readCurrentConversationBindingSelectionAsync(
  refs: readonly ConversationRef[],
  assertCurrent?: () => void,
): Promise<ReadonlyArray<SessionBindingRecord | null>> {
  const conversations = refs.map(captureConversationRef);
  const context = captureOpenClawStateWorkerContext();
  const result = await runOpenClawStateWorkerOperation(
    context,
    (scope) => scope.execute({ type: "conversationBindings.readSelection", input: conversations }),
    { assertCurrent, existingOnly: true, requireStateLifecycle: true },
  );
  context.admission.assertCurrent();
  assertCurrent?.();
  return result ?? conversations.map(() => null);
}

/** Domain input only crosses IPC; read/modify/write predicates execute in one worker transaction. */
export async function touchCurrentConversationBindingRecordAsync(
  input: CurrentConversationBindingTouch,
  assertCurrent?: () => void,
) {
  const captured: CurrentConversationBindingTouch = {
    conversation: captureConversationRef(input.conversation),
    bindingId: input.bindingId,
    at: input.at,
    ...(input.accountPolicy
      ? {
          accountPolicy: {
            idleTimeoutMs: input.accountPolicy.idleTimeoutMs,
            maxAgeMs: input.accountPolicy.maxAgeMs,
            targetKinds: {
              subagent: input.accountPolicy.targetKinds.subagent,
              session: input.accountPolicy.targetKinds.session,
            },
          },
        }
      : {}),
  };
  const context = captureOpenClawStateWorkerContext();
  return runOpenClawStateWorkerOperation(
    context,
    (scope) => scope.execute({ type: "conversationBindings.touch", input: captured }),
    {
      assertCurrent,
      createAdmission: createSqliteWorkerWriteAdmission(() => {
        context.admission.assertCurrent();
        assertCurrent?.();
      }, [context.admission.databasePath]),
    },
  );
}

/** Eligibility callbacks run before IPC; native grants only revalidate recorded ownership. */
function captureGenericBindingSupport(ref: ConversationRef) {
  const registry = getActivePluginChannelRegistrySnapshotFromState();
  const support = resolveChannelConversationBindingSupport(ref);
  const supportsCurrentConversationBinding = support?.supportsCurrentConversationBinding;
  const bindingStore = support?.bindingStore;
  const createManager = support?.createManager;
  const eligibility = support?.isCurrentConversationBindingSupported;
  const supported = supportsGenericCurrentConversationBinding(ref);
  const assertCurrent = () => {
    if (ref.channel === INTERNAL_MESSAGE_CHANNEL) {
      return;
    }
    if (
      getActivePluginChannelRegistrySnapshotFromState() !== registry ||
      resolveChannelConversationBindingSupport(ref) !== support ||
      support?.supportsCurrentConversationBinding !== supportsCurrentConversationBinding ||
      support?.bindingStore !== bindingStore ||
      support?.createManager !== createManager ||
      support?.isCurrentConversationBindingSupported !== eligibility
    ) {
      throw new SessionBindingError(
        "BINDING_ADAPTER_UNAVAILABLE",
        "Generic conversation binding owner is no longer available",
        { channel: ref.channel, accountId: ref.accountId },
      );
    }
  };
  assertCurrent();
  return { supported, assertCurrent };
}

export async function inspectGenericCurrentConversationBindingAsync(
  ref: ConversationRef,
  options?: { assertCurrent?: () => void },
): Promise<SessionBindingRecord | null> {
  const conversation = captureConversationRef(ref);
  const captured = captureGenericBindingSupport(conversation);
  if (!captured.supported) {
    return null;
  }
  options?.assertCurrent?.();
  const record = await inspectCurrentConversationBindingRecordAsync(conversation);
  options?.assertCurrent?.();
  captured.assertCurrent();
  return record?.bindingId.startsWith(CURRENT_BINDINGS_ID_PREFIX) ? record : null;
}

export async function resolveGenericCurrentConversationBindingAsync(
  ref: ConversationRef,
  options?: { assertCurrent?: () => void },
): Promise<SessionBindingRecord | null> {
  const conversation = captureConversationRef(ref);
  const captured = captureGenericBindingSupport(conversation);
  if (!captured.supported) {
    return null;
  }
  const record = await resolveCurrentConversationBindingRecordAsync(conversation, () => {
    options?.assertCurrent?.();
    captured.assertCurrent();
  });
  return record?.bindingId.startsWith(CURRENT_BINDINGS_ID_PREFIX) ? record : null;
}

export async function readGenericCurrentConversationBindingSelectionAsync(
  refs: readonly ConversationRef[],
  options?: { assertCurrent?: () => void },
): Promise<ReadonlyArray<SessionBindingRecord | null>> {
  const conversations = refs.map(captureConversationRef);
  const captured = conversations.map(captureGenericBindingSupport);
  const assertCurrent = () => {
    options?.assertCurrent?.();
    for (const support of captured) {
      support.assertCurrent();
    }
  };
  const eligible = conversations.filter((_, index) => captured[index]?.supported);
  assertCurrent();
  const records = await readCurrentConversationBindingSelectionAsync(eligible, assertCurrent);
  assertCurrent();
  let index = 0;
  return captured.map((support) => {
    const record = support.supported ? records[index++] : null;
    return record?.bindingId.startsWith(CURRENT_BINDINGS_ID_PREFIX) ? record : null;
  });
}

/** Plugin eligibility is evaluated only after native listing has settled. */
export async function listGenericCurrentConversationBindingsBySessionAsync(
  targetSessionKey: string,
  options?: { assertCurrent?: () => void },
): Promise<SessionBindingRecord[]> {
  const registry = getActivePluginChannelRegistrySnapshotFromState();
  const assertCurrent = () => {
    options?.assertCurrent?.();
    if (getActivePluginChannelRegistrySnapshotFromState() !== registry) {
      throw new SessionBindingError(
        "BINDING_ADAPTER_UNAVAILABLE",
        "Generic conversation binding owners changed during destination listing",
      );
    }
  };
  assertCurrent();
  const records = await listCurrentConversationBindingRecordsBySessionAsync(
    targetSessionKey,
    undefined,
    assertCurrent,
  );
  assertCurrent();
  const supports: ReturnType<typeof captureGenericBindingSupport>[] = [];
  const selected = records.filter((record) => {
    if (!record.bindingId.startsWith(CURRENT_BINDINGS_ID_PREFIX)) {
      return false;
    }
    const support = captureGenericBindingSupport(record.conversation);
    supports.push(support);
    assertCurrent();
    return support.supported;
  });
  assertCurrent();
  for (const support of supports) {
    support.assertCurrent();
  }
  return selected;
}

export async function touchGenericCurrentConversationBindingAsync(
  bindingId: string,
  at = Date.now(),
  scope?: SessionBindingScope,
  options?: { assertCurrent?: (ref: ConversationRef) => void },
): Promise<void> {
  const ref = bindingRefFromId(bindingId, scope);
  if (!ref) {
    return;
  }
  const conversation = captureConversationRef(ref);
  const captured = captureGenericBindingSupport(conversation);
  if (!captured.supported) {
    return;
  }
  await touchCurrentConversationBindingRecordAsync({ conversation, bindingId, at }, () => {
    options?.assertCurrent?.(conversation);
    captured.assertCurrent();
  });
}

export const testing = {
  clearPersistedCurrentConversationBindingsForTests() {
    runOpenClawStateWriteTransaction(({ db }) => {
      const bindingDb =
        getNodeSqliteKysely<Pick<OpenClawStateKyselyDatabase, "current_conversation_bindings">>(db);
      executeSqliteQuerySync(db, bindingDb.deleteFrom("current_conversation_bindings"));
    });
  },
};
