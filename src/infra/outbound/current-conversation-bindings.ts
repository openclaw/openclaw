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
  updateCurrentConversationBindingRecordInDatabase,
  inspectCurrentConversationBindingRecordInDatabase,
  readCurrentConversationBindingResolutionInDatabase,
  type CurrentConversationBindingScope,
} from "./current-conversation-bindings.kernel.js";
import type { CurrentConversationBindingTouch } from "./current-conversation-bindings.worker-contract.js";
import {
  buildChannelAccountKey,
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
  const rows = listCurrentConversationBindingRowsBySession(db, targetSessionKey, scope);
  const records = bindingRowsToRecords(rows);
  if (!records.some((record) => isBindingExpired(record))) {
    return records;
  }
  return runOpenClawStateWriteTransaction(({ db: transactionDb }) => {
    const latestRows = listCurrentConversationBindingRowsBySession(
      transactionDb,
      targetSessionKey,
      scope,
    );
    const active: SessionBindingRecord[] = [];
    for (const row of latestRows) {
      const record = bindingRowsToRecords([row])[0];
      if (!record || isBindingExpired(record)) {
        deleteCurrentConversationBindingRow(transactionDb, row.binding_key);
      } else {
        active.push(record);
      }
    }
    return active;
  });
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

function resolveChannelConversationBindingSupport(params: { channel: string; accountId: string }) {
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

function resolveChannelSupportsCurrentConversationBinding(params: {
  channel: string;
  accountId: string;
}): boolean {
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
export function requiresRegisteredSessionBindingAdapter(params: {
  channel: string;
  accountId: string;
}): boolean {
  const support = resolveChannelConversationBindingSupport(params);
  return support?.bindingStore === "adapter" || typeof support?.createManager === "function";
}

function supportsGenericCurrentConversationBinding(ref: {
  channel: string;
  accountId: string;
}): boolean {
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
export function getGenericCurrentConversationBindingCapabilities(params: {
  channel: string;
  accountId: string;
}): SessionBindingCapabilities | null {
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
  return updateCurrentConversationBindingRecord(conversation, (existing) => ({
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
  })).current;
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

/** Async transport carries only the canonical conversation identity, not caller context. */
function captureCurrentConversationRef(ref: ConversationRef): ConversationRef {
  const { channel, accountId, conversationId, parentConversationId } = ref;
  return normalizeConversationRef({
    channel,
    accountId,
    conversationId,
    ...(parentConversationId !== undefined ? { parentConversationId } : {}),
  });
}

/** Reads committed state without creating the store, pruning expiry, or repairing rows. */
export async function inspectCurrentConversationBindingRecordAsync(
  ref: ConversationRef,
): Promise<SessionBindingRecord | null> {
  const conversation = captureCurrentConversationRef(ref);
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
  const conversation = captureCurrentConversationRef(ref);
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

/** Domain input only crosses IPC; read/modify/write predicates execute in one worker transaction. */
export async function touchCurrentConversationBindingRecordAsync(
  input: CurrentConversationBindingTouch,
  assertCurrent?: () => void,
) {
  const captured: CurrentConversationBindingTouch = {
    conversation: captureCurrentConversationRef(input.conversation),
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
function captureGenericBindingAssertion(ref: ConversationRef): (() => void) | undefined {
  const registry = getActivePluginChannelRegistrySnapshotFromState();
  const support = resolveChannelConversationBindingSupport(ref);
  const eligibility = support?.isCurrentConversationBindingSupported;
  if (!supportsGenericCurrentConversationBinding(ref)) {
    return undefined;
  }
  const assertCurrent = () => {
    if (ref.channel === INTERNAL_MESSAGE_CHANNEL) {
      return;
    }
    if (
      getActivePluginChannelRegistrySnapshotFromState() !== registry ||
      resolveChannelConversationBindingSupport(ref) !== support ||
      support?.supportsCurrentConversationBinding !== true ||
      support.bindingStore === "adapter" ||
      typeof support.createManager === "function" ||
      support.isCurrentConversationBindingSupported !== eligibility
    ) {
      throw new Error("Generic conversation binding owner is no longer available");
    }
  };
  assertCurrent();
  return assertCurrent;
}

export async function inspectGenericCurrentConversationBindingAsync(
  ref: ConversationRef,
  options?: { assertCurrent?: () => void },
): Promise<SessionBindingRecord | null> {
  const conversation = captureCurrentConversationRef(ref);
  const assertGenericCurrent = captureGenericBindingAssertion(conversation);
  if (!assertGenericCurrent) {
    return null;
  }
  options?.assertCurrent?.();
  const record = await inspectCurrentConversationBindingRecordAsync(conversation);
  options?.assertCurrent?.();
  assertGenericCurrent();
  return record?.bindingId.startsWith(CURRENT_BINDINGS_ID_PREFIX) ? record : null;
}

export async function resolveGenericCurrentConversationBindingAsync(
  ref: ConversationRef,
  options?: { assertCurrent?: () => void },
): Promise<SessionBindingRecord | null> {
  const conversation = captureCurrentConversationRef(ref);
  const assertGenericCurrent = captureGenericBindingAssertion(conversation);
  if (!assertGenericCurrent) {
    return null;
  }
  const record = await resolveCurrentConversationBindingRecordAsync(conversation, () => {
    options?.assertCurrent?.();
    assertGenericCurrent();
  });
  return record?.bindingId.startsWith(CURRENT_BINDINGS_ID_PREFIX) ? record : null;
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
  const conversation = captureCurrentConversationRef(ref);
  const assertGenericCurrent = captureGenericBindingAssertion(conversation);
  if (!assertGenericCurrent) {
    return;
  }
  await touchCurrentConversationBindingRecordAsync({ conversation, bindingId, at }, () => {
    options?.assertCurrent?.(conversation);
    assertGenericCurrent();
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
