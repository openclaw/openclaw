import { isIncognitoSessionKey } from "../../../../src/shared/incognito-session-key.js";
import { getSafeSessionStorage } from "../../local-storage.ts";
import { resolveUiConversationIdentity } from "../sessions/session-key.ts";
import { compareChatQueueOrder } from "./chat-queue-order.ts";
import type { ChatQueueItem } from "./chat-types.ts";
import type { DurableChatDraftPresence } from "./composer-draft-store.runtime.ts";
import {
  observeOutboxRecoveryOwner,
  outboxPayloadMatchesOwner,
} from "./outbox-payload-store.runtime.ts";
import type { StoredComposerSession } from "./outbox-store-codec.ts";
import type { StoredChatOutboxScope } from "./outbox-store-scope.ts";
import {
  hasStoredComposerDraftInput,
  readProjectedOutboxStore,
  parseStoredChatOutboxScope,
  resolvePendingComposerSessions,
  storedChatOutboxScopeKey,
  storageTargetForGateway,
  subscribeStoredChatOutboxChanges,
  writeStoredOutboxStore,
  type ChatComposerScope,
} from "./outbox-store.ts";

export type StoredChatOutbox = StoredChatOutboxScope & { queue: ChatQueueItem[] };

type StoredOutboxReaderScope = ChatComposerScope &
  Required<Pick<ChatComposerScope, "client" | "connected">>;

/** One reader per mounted consumer; canonical storage events retire its projection. */
export function createStoredChatOutboxReader() {
  let cached: {
    inputs: readonly unknown[];
    summary: ReturnType<typeof summarizeStoredChatOutboxes>["summary"];
    draftSignature: string;
  } | null = null;
  let lastState: StoredOutboxReaderScope | undefined;
  const listeners = new Set<() => void>();
  let owner: { gatewayOwner: string; recoveryScope: string } | undefined;
  let presence: ReadonlyMap<string, DurableChatDraftPresence> | undefined;
  let generation = 0;
  let stale = true;
  let loading = false;
  let durableStore: typeof import("./composer-draft-store.runtime.ts") | undefined;
  let unsubscribeDurable: (() => void) | undefined;
  let unsubscribeTab: (() => void) | undefined;
  const invalidate = () => {
    cached = null;
  };
  const notify = () => {
    invalidate();
    for (const listener of listeners) {
      try {
        listener();
      } catch (error) {
        console.error("[openclaw] stored outbox reader listener failed", error);
      }
    }
  };
  const markStale = () => {
    generation += 1;
    stale = true;
  };
  const readInputs = (state: StoredOutboxReaderScope) => [
    state.settings?.gatewayUrl,
    state.assistantAgentId,
    state.agentsList,
    state.hello,
    state.client,
    state.client?.recoveryScope,
    state.client?.recoveryScopeReady,
    state.connected,
    presence,
  ];
  const updatePresence = (nextPresence: typeof presence) => {
    const previous = cached;
    const inputs = lastState ? readInputs(lastState) : undefined;
    presence = nextPresence;
    stale = false;
    if (
      previous &&
      lastState &&
      inputs?.every((value, index) => Object.is(value, previous.inputs[index])) &&
      summarizeStoredChatOutboxes(lastState, presence).draftSignature === previous.draftSignature
    ) {
      // A durable write can replace tab input without changing any rendered badge.
      previous.inputs = readInputs(lastState);
      return;
    }
    notify();
  };
  const loadPresence = async () => {
    if (loading || !stale || !owner || !listeners.size) {
      return;
    }
    loading = true;
    const loadOwner = owner;
    const loadGeneration = generation;
    try {
      durableStore ??= await import("./composer-draft-store.runtime.ts");
      if (!listeners.size) {
        return;
      }
      unsubscribeDurable ??= durableStore.subscribeDurableComposerDraftChanges(() => {
        markStale();
        void loadPresence();
      });
      if (loadGeneration !== generation) {
        return;
      }
      const result = await durableStore.listDurableChatDraftPresence(loadOwner);
      if (loadGeneration !== generation) {
        return;
      }
      updatePresence(result.status === "ready" ? result.presence : undefined);
    } catch {
      if (loadGeneration === generation) {
        updatePresence(undefined);
      }
    } finally {
      loading = false;
      void loadPresence();
    }
  };
  return {
    invalidate,
    subscribe(listener: () => void) {
      listeners.add(listener);
      unsubscribeTab ??= subscribeStoredChatOutboxChanges(notify);
      void loadPresence();
      return () => {
        listeners.delete(listener);
        if (!listeners.size) {
          unsubscribeTab?.();
          unsubscribeTab = undefined;
          unsubscribeDurable?.();
          unsubscribeDurable = undefined;
          // Changes while detached must be observed on the next subscription.
          markStale();
          presence = undefined;
          invalidate();
        }
      };
    },
    read(state: StoredOutboxReaderScope) {
      lastState = state;
      const gatewayOwner = storageTargetForGateway(state.settings?.gatewayUrl).gatewayOwner;
      const recoveryScope = observeOutboxRecoveryOwner(state);
      if (owner?.gatewayOwner !== gatewayOwner || owner?.recoveryScope !== recoveryScope) {
        owner = recoveryScope ? { gatewayOwner, recoveryScope } : undefined;
        presence = undefined;
        markStale();
      }
      void loadPresence();
      const inputs = readInputs(state);
      const previous = cached;
      if (previous && inputs.every((value, index) => Object.is(value, previous.inputs[index]))) {
        return previous.summary;
      }
      cached = { inputs, ...summarizeStoredChatOutboxes(state, presence) };
      return cached.summary;
    },
  };
}

function listStoredComposerRows(
  state: ChatComposerScope,
): Array<{ scope: StoredChatOutboxScope; session: StoredComposerSession }> {
  const storage = getSafeSessionStorage();
  if (!storage) {
    return [];
  }
  try {
    const target = storageTargetForGateway(state.settings?.gatewayUrl);
    const store = readProjectedOutboxStore(storage, target);
    if (resolvePendingComposerSessions(store, state)) {
      try {
        writeStoredOutboxStore(storage, target, store);
      } catch {
        // Readable pending records remain intact if quota blocks their transfer.
      }
    }
    return Object.entries(store.sessions).flatMap(([key, session]) => {
      const scope = parseStoredChatOutboxScope(key);
      return scope
        ? [
            {
              scope,
              session: {
                ...session,
                queue: session.queue?.filter((item) => outboxPayloadMatchesOwner(state, item)),
              },
            },
          ]
        : [];
    });
  } catch {
    return [];
  }
}

export function listStoredChatOutboxes(state: ChatComposerScope): StoredChatOutbox[] {
  return listStoredComposerRows(state)
    .flatMap(({ scope, session }) =>
      session.queue?.length
        ? [
            {
              ...scope,
              queue: session.queue.toSorted(compareChatQueueOrder),
            },
          ]
        : [],
    )
    .toSorted(
      (left, right) =>
        (left.queue[0]?.createdAt ?? Number.MAX_SAFE_INTEGER) -
          (right.queue[0]?.createdAt ?? Number.MAX_SAFE_INTEGER) ||
        left.sessionKey.localeCompare(right.sessionKey),
    );
}

export function readStoredChatOutbox(
  state: ChatComposerScope,
  scope: StoredChatOutboxScope,
): StoredChatOutbox | undefined {
  return listStoredChatOutboxes(state).find(
    (outbox) => outbox.sessionKey === scope.sessionKey && outbox.agentId === scope.agentId,
  );
}

function summarizeStoredChatOutboxes(
  state: ChatComposerScope,
  durablePresence?: ReadonlyMap<string, DurableChatDraftPresence>,
) {
  const idsByScope = new Map<string, { all: Set<string>; attention: Set<string> }>();
  const drafts = new Map<string, DurableChatDraftPresence>();
  for (const { scope, session } of listStoredComposerRows(state)) {
    const scopeKey = storedChatOutboxScopeKey(scope);
    if (!isIncognitoSessionKey(scope.sessionKey)) {
      drafts.set(scopeKey, {
        revision: session.draftRevision ?? 0,
        active: hasStoredComposerDraftInput(session),
      });
    }
    const ids = idsByScope.get(scopeKey) ?? {
      all: new Set<string>(),
      attention: new Set<string>(),
    };
    for (const item of session.queue ?? []) {
      if (!item.pendingRunId) {
        ids.all.add(item.id);
        if (
          item.sendState === "failed" ||
          item.sendState === "unconfirmed" ||
          item.sendState === "held"
        ) {
          ids.attention.add(item.id);
        }
      }
    }
    if (ids.all.size) {
      idsByScope.set(scopeKey, ids);
    }
  }
  for (const [scopeKey, durable] of durablePresence ?? []) {
    const scope = parseStoredChatOutboxScope(scopeKey);
    if (
      scope &&
      !isIncognitoSessionKey(scope.sessionKey) &&
      durable.revision >= (drafts.get(scopeKey)?.revision ?? 0)
    ) {
      drafts.set(scopeKey, durable);
    }
  }
  const attentionCountsByScope = new Map<string, number>();
  let total = 0;
  for (const [scopeKey, ids] of idsByScope) {
    total += ids.all.size;
    if (ids.attention.size) {
      attentionCountsByScope.set(scopeKey, ids.attention.size);
    }
  }
  // Resolve sidebar queries with this render's state; stored destinations stay captured.
  const sessionScopeKey = (sessionKey: string) =>
    storedChatOutboxScopeKey(resolveUiConversationIdentity(state, sessionKey));
  return {
    draftSignature: JSON.stringify(
      [...drafts].flatMap(([scopeKey, draft]) => (draft.active ? [scopeKey] : [])).toSorted(),
    ),
    summary: {
      total,
      attentionCountForSession: (sessionKey: string) =>
        attentionCountsByScope.get(sessionScopeKey(sessionKey)) ?? 0,
      hasSessionDraft: (sessionKey: string) =>
        Boolean(drafts.get(sessionScopeKey(sessionKey))?.active),
    },
  };
}
