import { expect, vi } from "vitest";
import type { ChatQueueItem } from "../../lib/chat/chat-types.ts";
import { outboxStorageScope } from "../../lib/chat/outbox-payload-store.runtime.ts";
import {
  captureChatOutboxRecoveryDestination,
  readChatOutboxRecovery,
  restoreChatOutboxRecovery,
} from "../../lib/chat/outbox-recovery.ts";
import {
  captureChatOutboxAdmission,
  storageTargetForComposer,
} from "../../lib/chat/outbox-store.ts";
import { resolveUiConversationIdentity } from "../../lib/sessions/session-key.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import {
  ChatComposerPersistence,
  admitStoredChatComposerQueueItem,
  loadChatComposerSnapshot,
  listStoredChatOutboxes,
  persistChatComposerState,
  removeStoredChatComposerQueueItem,
} from "./composer-persistence.ts";

type ComposerState = Parameters<typeof persistChatComposerState>[0] & {
  selectedChatSessionIncognito: boolean;
};

const LEGACY_STORAGE_KEY_PREFIX = "openclaw.control.chatComposer.v1:";

function gatewayOwner(gatewayUrl: string | null | undefined): string {
  return gatewayUrl?.trim() || "default";
}

export function legacyStorageKeyForGateway(gatewayUrl: string | null | undefined): string {
  return `${LEGACY_STORAGE_KEY_PREFIX}${encodeURIComponent(gatewayOwner(gatewayUrl)).slice(0, 240)}`;
}

export function createState(overrides: Partial<ComposerState> = {}): ComposerState {
  return {
    settings: { gatewayUrl: "ws://gateway.test/control" },
    connected: true,
    client: { recoveryScope: "credential", recoveryScopeReady: true },
    sessionKey: "agent:lily:main",
    chatMessage: "",
    chatQueue: [],
    selectedChatSessionIncognito: false,
    ...overrides,
  };
}

export function reconnectItem(id: string, createdAt: number, state = createState()): ChatQueueItem {
  return {
    id,
    text: `message ${id}`,
    createdAt,
    storageScope: outboxStorageScope(state),
    sendRunId: `run-${id}`,
    sendState: "waiting-reconnect",
  };
}

export function legacyReconnectItem(id: string, createdAt: number): ChatQueueItem {
  const { storageScope: _, ...item } = reconnectItem(id, createdAt);
  return item;
}

export function admitItem(
  state: ComposerState,
  item: ChatQueueItem,
  sessionKey = state.sessionKey,
) {
  return admitStoredChatComposerQueueItem(
    state,
    captureChatOutboxAdmission(state, sessionKey, item.agentId),
    item,
  );
}

export function reviewLegacyItem(state: ComposerState, id: string) {
  expect(loadChatComposerSnapshot(state, state.sessionKey)).toBeNull();
  expect(listStoredChatOutboxes(state)).toEqual([]);
  const entry = readChatOutboxRecovery(state).entries.find((candidate) =>
    candidate.session.queue?.some((item) => item.id === id),
  );
  expect(entry).toBeDefined();
  const destination = captureChatOutboxRecoveryDestination(
    state,
    resolveUiConversationIdentity(state, state.sessionKey),
  );
  expect(destination).not.toBeNull();
  expect(restoreChatOutboxRecovery(state, entry!, destination!)).toBe("restored");
  return loadChatComposerSnapshot(state, state.sessionKey)!.queue[0]!;
}

export function fillOutboxes(prefix: string, count = 20) {
  return Array.from({ length: count }, (_, index) => {
    const state = createState({ sessionKey: `agent:lily:${prefix}:${index}` });
    const item = reconnectItem(`${prefix}-${index}`, index);
    expect(admitItem(state, item)).toBe(true);
    return { state, item };
  });
}

export function releaseOutbox({ state, item }: ReturnType<typeof fillOutboxes>[number]) {
  expect(removeStoredChatComposerQueueItem(state, state.sessionKey, item.id, item)).toBe(true);
}

export function startPersistence(state: ComposerState) {
  const persistence = new ChatComposerPersistence(() => state);
  persistence.start();
  return persistence;
}

export function reloadStorage(state: ComposerState) {
  const storageKey = storageTargetForComposer(state).key;
  const stored = sessionStorage.getItem(storageKey);
  expect(stored).not.toBeNull();
  const freshStorage = createStorageMock();
  freshStorage.setItem(storageKey, stored!);
  vi.stubGlobal("sessionStorage", freshStorage);
}
