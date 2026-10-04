import { isIncognitoSessionKey } from "../../../../src/shared/incognito-session-key.js";
import { getSafeSessionStorage } from "../../local-storage.ts";
import { resolveUiConversationIdentity, hasUiSessionDefaults } from "../sessions/session-key.ts";
import type {
  ChatAttachment,
  ChatGoalDraftMode,
  ChatQueueItem,
  ChatReplyTarget,
  HumanMention,
} from "./chat-types.ts";
import { findChatSubmissionMessage } from "./history-message-identity.ts";
import {
  observeOutboxRecoveryOwner,
  outboxPayloadCanRecover,
} from "./outbox-payload-store.runtime.ts";
import { normalizeStoredSession } from "./outbox-store-codec.ts";
import { nextDraftRevision, readDraftRevisionState } from "./outbox-store-draft-state.ts";
import type { ComposerStorageTarget, StoredChatOutboxScope } from "./outbox-store-scope.ts";
import {
  hasStoredComposerDraftInput,
  notifyStoredChatOutboxChanges,
  parseStoredChatOutboxScope,
  readStoredOutboxStore,
  resolvePendingComposerSessions,
  storedChatOutboxScopeKey,
  storageTargetForGateway,
  storageTargetForComposer,
  writeStoredOutboxStore,
  type ChatComposerScope,
  type StoredComposerRecovery,
  type StoredComposerState,
} from "./outbox-store.ts";

export type ChatOutboxRecoveryEntry = StoredComposerRecovery & {
  id: string;
  owner: { gatewayOwner: string; recoveryScope?: string };
};
export type ChatOutboxRecoveryResult = "restored" | "conflict" | "storage-failed";

type RecoveryHost = ChatComposerScope & {
  sessionKey?: string;
  currentSessionId?: string | null;
  connectionEpoch?: number;
  chatMessage?: string;
  chatMentions?: readonly HumanMention[];
  chatGoalDraftMode?: ChatGoalDraftMode | null;
  chatReplyTarget?: ChatReplyTarget | null;
  chatAttachments?: readonly ChatAttachment[];
  chatQueue?: readonly ChatQueueItem[];
  chatMessages?: readonly unknown[];
};

// An existing recovery row owns an interrupted transfer, not a second live queue.
// Its key carries the account claim; the row retains the complete original input.
const TRANSFER_PREFIX = "transfer:";
const transferring = new WeakSet<Storage>();
function readTransfer(id: string): { account: string; sourceId: string } | undefined {
  if (!id.startsWith(TRANSFER_PREFIX)) {
    return undefined;
  }
  const value: unknown = JSON.parse(id.slice(TRANSFER_PREFIX.length));
  if (
    !Array.isArray(value) ||
    value.length !== 2 ||
    typeof value[0] !== "string" ||
    !value[0] ||
    typeof value[1] !== "string" ||
    !value[1]
  ) {
    throw new Error("Invalid outbox recovery transfer");
  }
  return { account: value[0], sourceId: value[1] };
}

function sameRecovery(
  left: StoredComposerRecovery | undefined,
  right: StoredComposerRecovery | undefined,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function legacySource(store: StoredComposerState, id: string): StoredComposerRecovery | undefined {
  const key = id.slice(id.indexOf(":") + 1);
  const session = store.sessions[key];
  return id.startsWith("legacy-session:")
    ? session && { sourceVersion: 4, sourceScopeKey: key, session }
    : store.recovery[key];
}

function removeLegacySource(store: StoredComposerState, id: string): void {
  const key = id.slice(id.indexOf(":") + 1);
  if (id.startsWith("legacy-session:")) {
    delete store.sessions[key];
  } else {
    delete store.recovery[key];
  }
}

// A retired source claim may already live only in an account recovery bucket.
// Discovery must not offer identical resurrected bytes to another account.
function transferClaims(
  storage: Storage,
  target: ComposerStorageTarget,
  legacy: StoredComposerState,
) {
  const stores = [legacy];
  const prefix = target.unscopedKey + ":account:";
  for (let index = 0; index < storage.length; index++) {
    const key = storage.key(index);
    if (key?.startsWith(prefix)) {
      stores.push(
        readStoredOutboxStore(storage, {
          ...target,
          key,
          recoveryScope: decodeURIComponent(key.slice(prefix.length)),
        }),
      );
    }
  }
  return stores.flatMap((store) =>
    Object.entries(store.recovery).flatMap(([id, entry]) => {
      const transfer = readTransfer(id);
      return transfer ? [{ ...transfer, entry }] : [];
    }),
  );
}

class RecoveryConflict extends Error {}

export function readChatOutboxRecovery(state: ChatComposerScope): {
  entries: ChatOutboxRecoveryEntry[];
  blocked: boolean;
} {
  const storage = getSafeSessionStorage();
  if (!storage) {
    throw new Error("Browser storage is unavailable");
  }
  const target = storageTargetForComposer(state);
  const store = readStoredOutboxStore(storage, target);
  // Legacy tab metadata has no account claim. Keep it in its original bucket
  // until an explicit review transfers a row; no login adopts or drains it.
  const legacy = target.recoveryScope
    ? readStoredOutboxStore(storage, storageTargetForGateway(state.settings?.gatewayUrl))
    : null;
  const recovery: Record<string, StoredComposerRecovery> = {};
  const add = (id: string, entry: StoredComposerRecovery, isLegacy = false) => {
    const account = readTransfer(id)?.account;
    if (account && account !== target.recoveryScope) {
      return;
    }
    const key = isLegacy && !account ? "legacy-recovery:" + id : id;
    if (recovery[key] && !sameRecovery(recovery[key], entry)) {
      throw new Error("Conflicting outbox recovery transfer");
    }
    recovery[key] = entry;
  };
  for (const [id, entry] of Object.entries(store.recovery)) {
    add(id, entry);
  }
  if (legacy) {
    const claims = transferClaims(
      storage,
      storageTargetForGateway(state.settings?.gatewayUrl),
      legacy,
    );
    const claimed = (id: string, entry: StoredComposerRecovery) =>
      claims.some((claim) => claim.sourceId === id && sameRecovery(claim.entry, entry));
    for (const [key, session] of Object.entries(legacy.sessions)) {
      const id = "legacy-session:" + key;
      const entry: StoredComposerRecovery = { sourceVersion: 4, sourceScopeKey: key, session };
      if (!claimed(id, entry)) {
        recovery[id] = entry;
      }
    }
    for (const [key, entry] of Object.entries(legacy.recovery)) {
      if (!claimed("legacy-recovery:" + key, entry)) {
        add(key, entry, true);
      }
    }
  }
  return {
    entries: Object.entries(recovery)
      // Clear fences are deliberately retained by storage to reject stale writers.
      // They are not input to recover, even when a legacy account has no destination.
      .filter(
        ([, entry]) =>
          (hasStoredComposerDraftInput(entry.session) || Boolean(entry.session.queue?.length)) &&
          (entry.session.queue ?? []).every((item) => outboxPayloadCanRecover(state, item)),
      )
      .map(([id, entry]) =>
        Object.assign({}, entry, {
          id,
          owner: { gatewayOwner: target.gatewayOwner, recoveryScope: target.recoveryScope },
        }),
      ),
    blocked: store.recoveryBlocked === true || legacy?.recoveryBlocked === true,
  };
}

export function captureChatOutboxRecoveryDestination(
  state: RecoveryHost,
  scope: StoredChatOutboxScope,
) {
  const storage = getSafeSessionStorage();
  const recoveryScope = observeOutboxRecoveryOwner(state);
  if (
    !storage ||
    !recoveryScope ||
    !hasUiSessionDefaults(state) ||
    state.selectedChatSessionIncognito ||
    isIncognitoSessionKey(scope.sessionKey) ||
    (state.connected && state.client && !state.client.recoveryScopeReady)
  ) {
    return null;
  }
  const target = storageTargetForComposer(state);
  const store = readStoredOutboxStore(storage, target);
  resolvePendingComposerSessions(store, state);
  const storeSessionKey = storedChatOutboxScopeKey(
    resolveUiConversationIdentity(state, scope.sessionKey, scope.agentId),
  );
  const session = store.sessions[storeSessionKey] ?? null;
  return {
    scope,
    gatewayOwner: target.gatewayOwner,
    recoveryScope,
    session: JSON.stringify(session),
    input: JSON.stringify([
      state.sessionKey,
      state.currentSessionId,
      state.connectionEpoch,
      state.chatMessage,
      state.chatMentions,
      state.chatGoalDraftMode,
      state.chatReplyTarget,
      state.chatAttachments,
      state.chatQueue,
    ]),
    revision: readDraftRevisionState(storage, target.key, storeSessionKey, session?.draftRevision)
      .latestAttempt,
  };
}

export function restoreChatOutboxRecovery(
  state: RecoveryHost,
  entry: ChatOutboxRecoveryEntry,
  destination: NonNullable<ReturnType<typeof captureChatOutboxRecoveryDestination>>,
  minimumRevision = 0,
): ChatOutboxRecoveryResult {
  const result = consumeChatOutboxRecovery(state, entry, destination, minimumRevision);
  return result === "completed" ? "restored" : result;
}

/** Call only after confirming discard; never publishes the source into a live queue. */
export function discardChatOutboxRecovery(
  state: RecoveryHost,
  entry: ChatOutboxRecoveryEntry,
  isCurrent: () => boolean = () => true,
): "discarded" | "conflict" | "storage-failed" {
  const result = consumeChatOutboxRecovery(state, entry, null, 0, isCurrent);
  return result === "completed" ? "discarded" : result;
}

/** Retire only exact durable user submissions in the currently loaded conversation. */
export function retireDeliveredChatOutboxRecovery(
  state: RecoveryHost,
  entries: readonly ChatOutboxRecoveryEntry[],
): "retired" | "unchanged" | "conflict" | "storage-failed" {
  if (!entries.length || !state.sessionKey || !hasUiSessionDefaults(state)) {
    return "unchanged";
  }
  const messages = state.chatMessages;
  const sessionId = state.currentSessionId;
  const scopeKey = storedChatOutboxScopeKey(resolveUiConversationIdentity(state, state.sessionKey));
  const isCurrent = () =>
    state.chatMessages === messages &&
    state.currentSessionId === sessionId &&
    Boolean(state.sessionKey) &&
    storedChatOutboxScopeKey(resolveUiConversationIdentity(state, state.sessionKey!)) === scopeKey;
  const delivered = (item: ChatQueueItem) => {
    if (item.sessionId && item.sessionId !== sessionId) {
      return false;
    }
    const proof = findChatSubmissionMessage(messages, item.sendRunId, true);
    return Boolean(proof && (proof.id !== null || proof.sequence !== null));
  };
  let retired = false;
  for (const entry of entries) {
    const source = parseStoredChatOutboxScope(entry.sourceScopeKey);
    if (
      !source ||
      storedChatOutboxScopeKey(source) !== scopeKey ||
      !entry.session.queue?.some(delivered)
    ) {
      continue;
    }
    // Consuming an unowned legacy row transfers it to the current account. Only
    // explicit Restore may adopt leftovers, so retire such rows only when nothing remains.
    const unowned =
      entry.id.startsWith("legacy-session:") || entry.id.startsWith("legacy-recovery:");
    if (
      unowned &&
      (hasStoredComposerDraftInput(entry.session) || !entry.session.queue.every(delivered))
    ) {
      continue;
    }
    const result = consumeChatOutboxRecovery(state, entry, null, 0, isCurrent, delivered);
    if (result !== "completed") {
      return result;
    }
    retired = true;
  }
  return retired ? "retired" : "unchanged";
}

// Restore, discard, and delivery retirement consume the same account claim. A partial transfer keeps
// one inert recovery owner, and canonical writes own verification and Blob cleanup.
function consumeChatOutboxRecovery(
  state: RecoveryHost,
  entry: ChatOutboxRecoveryEntry,
  destination: ReturnType<typeof captureChatOutboxRecoveryDestination>,
  minimumRevision = 0,
  isCurrentRequest: () => boolean = () => true,
  delivered?: (item: ChatQueueItem) => boolean,
): "completed" | "conflict" | "storage-failed" {
  const storage = getSafeSessionStorage();
  if (!storage) {
    return "storage-failed";
  }
  // Storage adapters can reenter synchronously. Durable staging owns resumption
  // after this call/document; this guard only serializes the current invocation.
  if (transferring.has(storage)) {
    return "conflict";
  }
  transferring.add(storage);
  try {
    const client = state.client;
    const target = storageTargetForComposer(state);
    const connectionEpoch = state.connectionEpoch;
    const isCurrent = () =>
      isCurrentRequest() &&
      getSafeSessionStorage() === storage &&
      state.client === client &&
      state.connectionEpoch === connectionEpoch &&
      !state.selectedChatSessionIncognito &&
      !isIncognitoSessionKey(state.sessionKey) &&
      Boolean(target.recoveryScope) &&
      entry.owner.gatewayOwner === target.gatewayOwner &&
      entry.owner.recoveryScope === target.recoveryScope &&
      JSON.stringify(storageTargetForComposer(state)) === JSON.stringify(target) &&
      (!destination ||
        JSON.stringify(captureChatOutboxRecoveryDestination(state, destination.scope)) ===
          JSON.stringify(destination));
    if (!isCurrent()) {
      return "conflict";
    }
    const commit = (
      commitTarget: ComposerStorageTarget,
      next: StoredComposerState,
      before: string,
      options: { requiredSessionKey?: string; validate?: () => boolean } = {},
    ) =>
      writeStoredOutboxStore(storage, commitTarget, next, {
        requiredSessionKey: options.requiredSessionKey,
        beforeCommit: () => {
          if (
            (options.validate && !options.validate()) ||
            JSON.stringify(readStoredOutboxStore(storage, commitTarget)) !== before ||
            !isCurrent()
          ) {
            throw new RecoveryConflict();
          }
        },
      });
    let store = readStoredOutboxStore(storage, target);
    if (destination) {
      const initialScope = resolveUiConversationIdentity(
        state,
        destination.scope.sessionKey,
        destination.scope.agentId,
      );
      const initialKey = storedChatOutboxScopeKey(initialScope);
      const initial = store.sessions[initialKey];
      if (
        initialKey !== storedChatOutboxScopeKey(destination.scope) ||
        initial?.draft ||
        initial?.goalMode ||
        initial?.replyTarget ||
        initial?.queue?.length
      ) {
        return "conflict";
      }
    }
    const { id, owner: _owner, ...expected } = entry;
    const legacyTarget = storageTargetForGateway(state.settings?.gatewayUrl);
    const transfer = readTransfer(id);
    const account = transfer?.account;
    const sourceId = transfer?.sourceId ?? id;
    let recoveryId = id;
    const legacyTransfer = Boolean(account || id.startsWith("legacy-"));
    const sourceRetired = () => {
      if (!legacyTransfer) {
        return true;
      }
      const current = readStoredOutboxStore(storage, legacyTarget);
      return (
        !current.recovery[recoveryId] && !sameRecovery(legacySource(current, sourceId), expected)
      );
    };
    if (account || id.startsWith("legacy-")) {
      if (account && account !== target.recoveryScope) {
        return "conflict";
      }
      let legacy = readStoredOutboxStore(storage, legacyTarget);
      recoveryId = account ? id : TRANSFER_PREFIX + JSON.stringify([target.recoveryScope, id]);
      if (!account) {
        const source = legacySource(legacy, id);
        if (source) {
          if (
            !sameRecovery(source, expected) ||
            transferClaims(storage, legacyTarget, legacy).some(
              (claim) => claim.sourceId === id && sameRecovery(claim.entry, expected),
            ) ||
            legacy.recovery[recoveryId] ||
            store.recovery[recoveryId] ||
            !(entry.session.queue ?? []).every((item) => outboxPayloadCanRecover(state, item)) ||
            !isCurrent()
          ) {
            return "conflict";
          }
          // Claim and retire the unowned source in one verified bucket write.
          // A failed claim never publishes input into any destination.
          const before = JSON.stringify(legacy);
          legacy.recovery[recoveryId] = expected;
          removeLegacySource(legacy, id);
          commit(legacyTarget, legacy, before);
          legacy = readStoredOutboxStore(storage, legacyTarget);
          if (!sameRecovery(legacy.recovery[recoveryId], expected)) {
            return "storage-failed";
          }
        }
      }
      let claimed = legacy.recovery[recoveryId];
      const staged = store.recovery[recoveryId];
      if (
        (!claimed && !staged) ||
        (claimed && !sameRecovery(claimed, expected)) ||
        (staged && !sameRecovery(staged, expected)) ||
        !(entry.session.queue ?? []).every((item) => outboxPayloadCanRecover(state, item)) ||
        !isCurrent()
      ) {
        return "conflict";
      }
      if (account && sameRecovery(legacySource(legacy, sourceId), expected)) {
        // Explicit resumption can retire an identical reappearance only while a
        // verified staging copy owns every byte. Different newer input stays put.
        const before = JSON.stringify(legacy);
        legacy.recovery[recoveryId] = expected;
        removeLegacySource(legacy, sourceId);
        commit(legacyTarget, legacy, before);
        legacy = readStoredOutboxStore(storage, legacyTarget);
        claimed = legacy.recovery[recoveryId];
        if (
          !sameRecovery(claimed, expected) ||
          sameRecovery(legacySource(legacy, sourceId), expected)
        ) {
          return "storage-failed";
        }
      }
      if (claimed) {
        // Copy into the existing account recovery bucket before releasing the
        // claim. Both copies remain inert and expose one recovery entry.
        store = readStoredOutboxStore(storage, target);
        if (store.recovery[recoveryId] && !sameRecovery(store.recovery[recoveryId], expected)) {
          return "conflict";
        }
        if (!store.recovery[recoveryId]) {
          if (!isCurrent()) {
            return "conflict";
          }
          const before = JSON.stringify(store);
          store.recovery[recoveryId] = expected;
          commit(target, store, before);
          store = readStoredOutboxStore(storage, target);
          if (!sameRecovery(store.recovery[recoveryId], expected)) {
            return "storage-failed";
          }
        }
        legacy = readStoredOutboxStore(storage, legacyTarget);
        if (
          !sameRecovery(legacy.recovery[recoveryId], expected) ||
          sameRecovery(legacySource(legacy, sourceId), expected) ||
          !isCurrent()
        ) {
          return "conflict";
        }
        const before = JSON.stringify(legacy);
        delete legacy.recovery[recoveryId];
        commit(legacyTarget, legacy, before);
        if (!sourceRetired()) {
          return "conflict";
        }
      }
      store = readStoredOutboxStore(storage, target);
    }
    if (
      !sameRecovery(store.recovery[recoveryId], expected) ||
      !(entry.session.queue ?? []).every((item) => outboxPayloadCanRecover(state, item)) ||
      !isCurrent()
    ) {
      return "conflict";
    }
    const before = JSON.stringify(store);
    let key: string | undefined;
    if (destination) {
      const scope = resolveUiConversationIdentity(
        state,
        destination.scope.sessionKey,
        destination.scope.agentId,
      );
      key = storedChatOutboxScopeKey(scope);
      if (key !== storedChatOutboxScopeKey(destination.scope)) {
        return "conflict";
      }
      const existing = store.sessions[key];
      if (
        existing?.draft ||
        existing?.goalMode ||
        existing?.replyTarget ||
        existing?.queue?.length
      ) {
        return "conflict";
      }
      const session = entry.session;
      store.sessions[key] = {
        ...session,
        awaitingDefaults: undefined,
        draftRevision: nextDraftRevision(
          Math.max(minimumRevision, destination.revision, session.draftRevision ?? 0),
        ),
        queue: session.queue?.map((item) =>
          Object.assign({}, item, scope, {
            storageScope: JSON.stringify([destination.gatewayOwner, destination.recoveryScope]),
            sendState:
              item.sendState === "held"
                ? "held"
                : (item.sendAttempts ?? 0) > 0 || item.sendState === "unconfirmed"
                  ? "unconfirmed"
                  : "failed",
            sendError:
              item.sendError ??
              "Recovered message. Review this destination and retry only if it did not arrive.",
          }),
        ),
      };
    }
    // Partial delivery retains the authoritative row's draft and unproven inputs.
    const current = store.recovery[recoveryId]!;
    const remainingQueue = delivered
      ? current.session.queue?.filter((item) => !delivered(item))
      : [];
    const retained =
      delivered && (hasStoredComposerDraftInput(current.session) || remainingQueue?.length)
        ? {
            ...current,
            session: normalizeStoredSession({ ...current.session, queue: remainingQueue })!,
          }
        : undefined;
    // Publication or retirement consumes the account recovery row in the same write.
    // No rollback is needed: every earlier failure retains an inert durable owner.
    if (retained) {
      store.recovery[recoveryId] = retained;
    } else {
      delete store.recovery[recoveryId];
    }
    if (!isCurrent()) {
      return "conflict";
    }
    commit(target, store, before, { requiredSessionKey: key, validate: sourceRetired });
    const written = readStoredOutboxStore(storage, target);
    if (
      !sameRecovery(written.recovery[recoveryId], retained) ||
      (key !== undefined &&
        JSON.stringify(written.sessions[key]) !==
          JSON.stringify(normalizeStoredSession(store.sessions[key])))
    ) {
      return "storage-failed";
    }
    notifyStoredChatOutboxChanges();
    return "completed";
  } catch (error) {
    return error instanceof RecoveryConflict ? "conflict" : "storage-failed";
  } finally {
    transferring.delete(storage);
  }
}
